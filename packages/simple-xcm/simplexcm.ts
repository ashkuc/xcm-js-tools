import {ApiPromise, WsProvider} from '@polkadot/api';
import {SubmittableExtrinsic} from '@polkadot/api/types';
import {Bytes, Result} from '@polkadot/types-codec';
import {Codec} from '@polkadot/types-codec/types';
import {Registry} from './registry';
import {stringify} from '@polkadot/util';
import {
  AssetIdLookup,
  AssetLookup,
  ChainInfo,
  InteriorLocation,
  LocationLookup,
  PalletXcmName,
  XcmVersion,
  Location,
  InteriorLocationLookup,
  Origin,
  AssetId,
  Asset,
  VersionedLocation,
  RegistryLookup,
  FungibleAnyAsset,
  VersionedAssets,
  VersionedAsset,
} from '@open-xcm-tools/xcm-types';
import {
  convertAssetIdVersion,
  convertLocationVersion,
  extractVersion,
  findPalletXcm,
  location,
  locationRelativeToPrefix,
  palletApiTxName,
  prepareAssetsForEncoding,
  relativeLocationToUniversal,
  sanitizeInterior,
  sanitizeLookup,
  toJunctions,
} from '@open-xcm-tools/xcm-util';
import {Estimator, findFeeAssetById} from '@open-xcm-tools/xcm-estimate';
import {sanitizeTransferParams} from './main-utils';
import {
  FeeEstimationErrors,
  TooExpensiveFeeError,
} from '@open-xcm-tools/xcm-estimate/errors';
import {
  unwrapVersionedAsset,
  unwrapVersionedAssets,
} from '@open-xcm-tools/xcm-util/convert-xcm-version/convert-xcm-version';

interface TransferBackend {
  composeTransfer(
    transferParams: TransferParams,
  ): Promise<SubmittableExtrinsic<'promise'>>;
}

/**
 * Parameters for transferring tokens between chains.
 */
export type TransferParams = {
  origin: Origin | RegistryLookup; // The origin of the transfer.
  assets: AssetLookup[]; // The assets to be transferred.
  feeAssetId: AssetIdLookup; // The asset used to pay the transfer fee.
  destination: LocationLookup; // The destination location for the transfer.
  beneficiary: LocationLookup; // The beneficiary of the transferred assets.
};

type PreparedTransferParams = {
  origin: Origin;
  assets: VersionedAssets;
  feeAssetId: AssetId;
  feeAssetIndex: number;
  feeAnyAssetRef: FungibleAnyAsset; // docs
  destination: Location;
  beneficiary: Location;
};

/**
 * Class representing a simple XCM interface for cross-chain transfers.
 */
export class SimpleXcm {
  api: ApiPromise;
  registry: Registry;
  chainInfo: ChainInfo;
  palletXcm: PalletXcmName;
  estimator: Estimator;
  xcmVersion: XcmVersion;

  /**
   * Composes a transfer extrinsic based on the provided parameters.
   * @param transferParams - The parameters for the transfer.
   * @returns A promise that resolves to a SubmittableExtrinsic for the transfer.
   */
  composeTransfer(
    transferParams: TransferParams,
  ): Promise<SubmittableExtrinsic<'promise'>> {
    return this.#transferBackend().composeTransfer(transferParams);
  }

  /**
   * Enforces the specified XCM version for the transfer.
   * @param version - The XCM version to enforce.
   * @throws Will throw an error if the requested version exceeds the maximum supported version.
   */
  enforceXcmVersion(version: XcmVersion) {
    if (version > this.estimator.xcmVersion) {
      throw new Error(
        `The requested XCM version ${version} is greater than the chain supports (= ${this.estimator.xcmVersion})`,
      );
    }

    this.xcmVersion = version;
  }

  /**
   * Adjusts the fungible asset amount based on the asset ID and amount.
   * @param assetId - The ID of the asset.
   * @param amount - The amount of the asset as a string.
   * @returns The adjusted asset lookup object.
   */
  adjustedFungible(assetId: AssetIdLookup, amount: string): AssetLookup {
    sanitizeLookup(assetId);
    let decimals: number;

    if (typeof assetId === 'string') {
      decimals = this.registry.currencyInfoBySymbol(assetId).decimals;
    } else {
      const currencyUniversalLocation = relativeLocationToUniversal({
        relativeLocation: assetId,
        context: this.chainInfo.identity.universalLocation,
      });

      decimals = this.registry.currencyInfoByUniversalLocation(
        currencyUniversalLocation,
      ).decimals;
    }

    const value = this.#convertFungibleAmount(amount, decimals);

    return {
      id: assetId,
      fun: {fungible: value},
    };
  }

  /**
   * Disconnects from the API.
   */
  async disconnect() {
    await this.api.disconnect();
  }

  /**
   * Private constructor for initializing the SimpleXcm instance.
   * @param apiPromise - The API promise instance.
   * @param registry - The registry instance.
   * @param chainInfo - Information about the connected chain.
   * @param palletXcm - The name of the XCM pallet.
   * @param maxXcmVersion - The maximum supported XCM version.
   */
  private constructor(
    apiPromise: ApiPromise,
    registry: Registry,
    chainInfo: ChainInfo,
    palletXcm: PalletXcmName,
    estimator: Estimator,
  ) {
    this.api = apiPromise;
    this.registry = registry;
    this.chainInfo = chainInfo;
    this.palletXcm = palletXcm;
    this.estimator = estimator;
    this.xcmVersion = estimator.xcmVersion;
  }

  /**
   * Creates and connects a new SimpleXcm instance.
   * @param chainId - The ID of the chain to connect to.
   * @param registry - The registry instance.
   * @returns A promise that resolves to a SimpleXcm instance.
   * @throws Will throw an error if no pallet-xcm is found in the runtime.
   */
  static async connect(chainId: string, registry: Registry) {
    const chainInfo = registry.chainInfoById(chainId);

    const provider = new WsProvider(chainInfo.endpoints);
    const api = await ApiPromise.create({provider});

    const palletXcm = findPalletXcm(api);
    if (!palletXcm) {
      throw new Error(`${chainId}: no pallet-xcm found in the runtime`);
    }

    const xcmVersion = await Estimator.estimateMaxXcmVersion(
      api,
      chainInfo.identity.name,
      palletXcm,
    );
    const estimator = new Estimator(api, chainInfo.identity, xcmVersion);

    return new SimpleXcm(api, registry, chainInfo, palletXcm, estimator);
  }

  /**
   * Resolves a relative location to an absolute location.
   * @param lookup - The relative location or location lookup.
   * @returns The resolved absolute location.
   * @throws Will throw an error if the location is unknown.
   */
  resolveRelativeLocation(lookup: InteriorLocation | LocationLookup): Location {
    if (typeof lookup === 'string') {
      const universalLocation = this.registry.universalLocation(lookup);
      if (universalLocation) {
        return locationRelativeToPrefix({
          location: universalLocation,
          prefix: this.chainInfo.identity.universalLocation,
        });
      }

      const relativeLocation = this.registry.relativeLocation(lookup);
      if (relativeLocation) {
        return relativeLocation;
      }

      throw new Error(`${lookup}: unknown named location`);
    } else if ('parents' in lookup) {
      sanitizeLookup(lookup);
      return lookup;
    } else {
      sanitizeInterior(lookup);
      return locationRelativeToPrefix({
        location: lookup,
        prefix: this.chainInfo.identity.universalLocation,
      });
    }
  }

  /**
   * Resolves a location lookup to an absolute universal location.
   * @param lookup - The location lookup.
   * @returns The resolved universal location.
   * @throws Will throw an error if the location is unknown.
   */
  resolveUniversalLocation(lookup: InteriorLocationLookup): InteriorLocation {
    if (typeof lookup === 'string') {
      const universalLocation = this.registry.universalLocation(lookup);
      if (universalLocation) {
        return universalLocation;
      }

      const relativeLocation = this.registry.relativeLocation(lookup);
      if (relativeLocation) {
        return relativeLocationToUniversal({
          relativeLocation,
          context: this.chainInfo.identity.universalLocation,
        });
      }

      throw new Error(`${lookup}: unknown named location`);
    } else {
      sanitizeInterior(lookup);
      return lookup;
    }
  }

  async tryEstimateExtrinsicXcmFees(
    origin: Origin,
    xt: SubmittableExtrinsic<'promise'>,
    feeAssetId: AssetId,
  ): Promise<{value: bigint} | {error: TooExpensiveFeeError}> {
    try {
      const estimatedFees = await this.estimator.estimateExtrinsicFees(
        origin,
        xt,
        feeAssetId,
        {
          estimatorResolver: (universalLocation: InteriorLocation) =>
            Estimator.connect(
              this.registry.chainInfoByUniversalLocation(universalLocation),
            ),
        },
      );
      return {value: estimatedFees};
    } catch (errors) {
      if (errors instanceof FeeEstimationErrors) {
        const tooExpensiveErrors = errors.errors.filter(
          error => error instanceof TooExpensiveFeeError,
        );
    
        if (tooExpensiveErrors.length > 0) {
          const totalValue = tooExpensiveErrors.reduce((sum, error) => {
            return sum + error.missingAmount;
          }, BigInt(0));
    
          return { error: new TooExpensiveFeeError(totalValue) };
        }
      }
      throw errors;
    }
  }

  /**
   * Resolves a relative asset lookup to an absolute asset.
   * @param lookup - The asset lookup.
   * @returns The resolved asset.
   */
  resolveRelativeAsset(lookup: AssetLookup): Asset {
    return {
      id: this.resolveRelativeLocation(lookup.id),
      fun: lookup.fun,
    };
  }

  /**
   * Converts a location lookup to an account ID.
   * @param lookup - The location lookup.
   * @returns A promise that resolves to the account ID.
   * @throws Will throw an error if the conversion fails.
   */
  async locationToAccountId(lookup: LocationLookup): Promise<string> {
    if (this.api.call.locationToAccountApi === undefined) {
      throw new Error(
        `${this.chainInfo.identity.name} doesn't implement locationToAccount Runtime API`,
      );
    }

    if (typeof lookup === 'string') {
      const accountLocation = this.resolveRelativeLocation(lookup);
      return this.locationToAccountId(accountLocation);
    }
    sanitizeLookup(lookup);

    const versionedLocation: VersionedLocation = {v4: lookup};
    const result: Result<Bytes, Codec> =
      await this.api.call.locationToAccountApi.convertLocation(
        versionedLocation,
      );

    if (result.isErr) {
      throw new Error(
        `${this.chainInfo.identity.name}: can't convert location to an account ID - ${stringify(result.asErr.toHuman())}`,
      );
    }

    return result.asOk.toHex();
  }

  /**
   * Converts a fungible amount from a string representation to a bigint.
   * @param amount - The amount as a string.
   * @param decimals - The number of decimals for the asset.
   * @returns The converted amount as a bigint.
   * @throws Will throw an error if the amount format is invalid or if the decimals value is incorrect.
   */
  #convertFungibleAmount(amount: string, decimals: number): bigint {
    // RegEx for number validation
    // Example:
    // 0.23, 123, 12.232 - OK
    // 023, 023.23, text, 2.text - Invalid
    const numberRegEx = /^(0(\.\d+)?|[1-9]\d*(\.\d+)?)$/;

    const isValidNumber = numberRegEx.test(amount);
    if (!isValidNumber) {
      throw new Error(
        'convertFungibleAmount: invalid amount format. Must be an integer or decimal number.',
      );
    }
    const [integerPart, decimalPart = ''] = amount.split('.');

    if (!Number.isSafeInteger(decimals) || decimals < 0 || decimals > 38) {
      throw new Error(
        'convertFungibleAmount: decimals value is incorrect. Expected an integer between 1 and 38',
      );
    }
    const paddedDecimalPart = decimalPart.padEnd(decimals, '0');

    if (paddedDecimalPart.length > decimals) {
      throw new Error(
        `convertFungibleAmount: the fungible amount's decimal part length (${paddedDecimalPart.length}) is greater than the currency decimals (${decimals})`,
      );
    }
    return BigInt(integerPart + paddedDecimalPart);
  }

  /**
   * Retrieves the appropriate transfer backend based on the available extrinsics.
   * @returns The transfer backend instance.
   * @throws Will throw an error if no known backend pallet is found.
   */
  #transferBackend() {
    if ('transferAssets' in this.api.tx[this.palletXcm]) {
      return new PalletXcmBackend(this);
    }

    console.warn(`
      ${this.chainInfo.identity.name}: pallet-xcm does not have the needed "transferAssets" extrinsic.
      Looking for an alternative XCM transfer backend...
    `);

    const pallets = this.api.registry.metadata.pallets;

    let palletName: string;
    let backend: TransferBackend | undefined;
    for (const pallet of pallets) {
      const palletRuntimeName = pallet.name.toPrimitive();
      palletName = palletApiTxName(palletRuntimeName);

      switch (palletName) {
        // TODO test XTokensBackend
        // case 'xTokens':
        //   backend = new XTokensBackend(this);
        //   break loop;

        default:
      }
    }

    if (backend) {
      console.warn(
        `${this.chainInfo.identity.name}: using an alternative XCM transfer backend - ${palletName!}`,
      );
      return backend;
    } else {
      throw new Error(
        `${this.chainInfo.identity.name}: No known XCM transfer backend pallet is found`,
      );
    }
  }
}

/**
 * Class representing the backend for the XCM pallet.
 */
class PalletXcmBackend implements TransferBackend {
  simpleXcm: SimpleXcm;

  /**
   * Constructor for the PalletXcmBackend.
   * @param simpleXcm - The SimpleXcm instance.
   */
  constructor(simpleXcm: SimpleXcm) {
    this.simpleXcm = simpleXcm;
  }

  /**
   * Composes a transfer extrinsic based on the provided parameters.
   * @param transferParams - The parameters for the transfer.
   * @returns A promise that resolves to a SubmittableExtrinsic for the transfer.
   */
  async composeTransfer(
    transferParams: TransferParams,
  ): Promise<SubmittableExtrinsic<'promise'>> {
    const preparedParams = await prepareTransferParams(
      this.simpleXcm,
      transferParams,
    );
  
    const xcmVersion = this.simpleXcm.xcmVersion;
  
    const destination = convertLocationVersion(
      xcmVersion,
      preparedParams.destination,
    );
    const beneficiary = convertLocationVersion(
      xcmVersion,
      preparedParams.beneficiary,
    );
  
    const palletXcm = this.simpleXcm.api.tx[this.simpleXcm.palletXcm];
    const noXcmWeightLimit = 'Unlimited';
  
    let estimatedFees;
    do {
      const txToDryRun = palletXcm.transferAssets(
        destination,
        beneficiary,
        preparedParams.assets,
        preparedParams.feeAssetIndex,
        noXcmWeightLimit,
      );
  
      estimatedFees = await this.simpleXcm.tryEstimateExtrinsicXcmFees(
        preparedParams.origin,
        txToDryRun,
        preparedParams.feeAssetId,
      );
  
      if ('error' in estimatedFees) {
        if ('fungible' in preparedParams.feeAnyAssetRef.fun) {
          preparedParams.feeAnyAssetRef.fun.fungible += estimatedFees.error.missingAmount;
        }
      } else {
        preparedParams.feeAnyAssetRef.fun.fungible += estimatedFees.value;
      }
    } while ('error' in estimatedFees);
  
    const tx = palletXcm.transferAssets(
      destination,
      beneficiary,
      preparedParams.assets,
      preparedParams.feeAssetIndex,
      noXcmWeightLimit,
    );
  
    await Estimator.dryRunExtrinsic(
      this.simpleXcm.api,
      preparedParams.origin,
      tx,
    );
  
    return tx;
  }
  

/**
 * Class representing the backend for the XTokens pallet.
 */
class XTokensBackend implements TransferBackend {
  simpleXcm: SimpleXcm;

  /**
   * Constructor for the XTokensBackend.
   * @param simpleXcm - The SimpleXcm instance.
   */
  constructor(simpleXcm: SimpleXcm) {
    this.simpleXcm = simpleXcm;
  }

  /**
   * Composes a transfer extrinsic based on the provided parameters.
   * @param transferParams - The parameters for the transfer.
   * @returns A promise that resolves to a SubmittableExtrinsic for the transfer.
   * @throws Will throw an error if the beneficiary is not an interior location.
   */
  async composeTransfer(
    transferParams: TransferParams,
  ): Promise<SubmittableExtrinsic<'promise'>> {
    const preparedParams = await prepareTransferParams(
      this.simpleXcm,
      transferParams,
    );

    if (preparedParams.beneficiary.parents !== 0n) {
      throw new Error(`
        The beneficiary must be an interior location (parents = 0) when using the XTokens backend.
        The actual parents = ${preparedParams.beneficiary.parents}
      `);
    }

    const beneficiaryJunctions = toJunctions(
      preparedParams.beneficiary.interior,
    );
    const destinationJunctions = toJunctions(
      preparedParams.destination.interior,
    );

    const destinationBeneficiary = location(
      preparedParams.destination.parents,
      [...destinationJunctions, ...beneficiaryJunctions],
    );

    const xcmVersion = this.simpleXcm.xcmVersion;

    const destination = convertLocationVersion(
      xcmVersion,
      destinationBeneficiary,
    );

    const xTokens = this.simpleXcm.api.tx['xTokens'];
    const noXcmWeightLimit = 'Unlimited';

    const txToDryRun = xTokens.transferMultiassets(
      preparedParams.assets,
      preparedParams.feeAssetIndex,
      destination,
      noXcmWeightLimit,
    );

    const estimatedFees = await this.simpleXcm.tryEstimateExtrinsicXcmFees(
      preparedParams.origin,
      txToDryRun,
      preparedParams.feeAssetId,
    );

    if ('value' in estimatedFees) {
      preparedParams.feeAnyAssetRef.fun.fungible += estimatedFees.value;
    }

    const tx = xTokens.transferMultiassets(
      preparedParams.assets,
      preparedParams.feeAssetIndex,
      destination,
      noXcmWeightLimit,
    );

    return tx;
  }
  }
}

/**
 * Prepares the transfer parameters for the transfer.
 * @param simpleXcm - The SimpleXcm instance.
 * @param transferParams - The parameters for the transfer.
 * @returns A promise that resolves to the prepared transfer parameters.
 */
export async function prepareTransferParams(
  simpleXcm: SimpleXcm,
  transferParams: TransferParams,
): Promise<PreparedTransferParams> {
  let origin: Origin;
  if (typeof transferParams.origin === 'string') {
    origin = {
      System: {
        Signed: await simpleXcm.locationToAccountId(transferParams.origin),
      },
    };
  } else {
    origin = transferParams.origin;
  }

  sanitizeTransferParams(transferParams);

  const destination = simpleXcm.resolveRelativeLocation(
    transferParams.destination,
  );
  const beneficiary = simpleXcm.resolveRelativeLocation(
    transferParams.beneficiary,
  );
  const feeAssetId = simpleXcm.resolveRelativeLocation(
    transferParams.feeAssetId,
  );

  const resolvedAssets = transferParams.assets.map(asset =>
    simpleXcm.resolveRelativeAsset(asset),
  );

  const assets = prepareAssetsForEncoding(simpleXcm.xcmVersion, resolvedAssets);

  const convertedFeeAssetId = convertAssetIdVersion(
    simpleXcm.xcmVersion,
    feeAssetId,
  );
  const feeAssetResult = findFeeAssetById(convertedFeeAssetId, assets);

  let feeAnyAsset: FungibleAnyAsset;
  let feeAssetIndex: number;

  if (feeAssetResult === undefined) {
    // FIXME refactor fee estimation so that it can estimate fees when the fee asset
    // is neither part of the transfer nor above the minimum amount to cover the fees.
    throw Error(
      `${simpleXcm.chainInfo.identity.name}: failed to compose transfer, the fee asset isn't part of the transfer (a temporary limitation, see README)`,
    );

    // const feeAsset = {
    //   id: feeAssetId,
    //   fun: fungible(2n),
    // };
    // resolvedAssets.push(feeAsset);

    // assets = prepareAssetsForEncoding(simpleXcm.xcmVersion, resolvedAssets);
    // [feeAnyAsset, feeAssetIndex] = findFeeAssetById(feeAssetId, assets)!;
  } else {
    [feeAnyAsset, feeAssetIndex] = feeAssetResult;
  }

  return {
    origin,
    assets,
    feeAssetId,
    feeAssetIndex,
    feeAnyAssetRef: feeAnyAsset,
    destination,
    beneficiary,
  };
}
