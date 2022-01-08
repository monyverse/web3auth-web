import CustomAuth, {
  AggregateLoginParams,
  CustomAuthArgs,
  HybridAggregateLoginParams,
  InitParams,
  SingleLoginParams,
  TORUS_METHOD,
  TorusAggregateLoginResponse,
  TorusHybridAggregateLoginResponse,
  TorusLoginResponse,
  UX_MODE,
} from "@toruslabs/customauth";
import { getED25519Key } from "@toruslabs/openlogin-ed25519";
import {
  ADAPTER_CATEGORY,
  ADAPTER_CATEGORY_TYPE,
  ADAPTER_NAMESPACES,
  ADAPTER_STATUS,
  ADAPTER_STATUS_TYPE,
  AdapterInitOptions,
  AdapterNamespaceType,
  BaseAdapter,
  CHAIN_NAMESPACES,
  ChainNamespaceType,
  CustomChainConfig,
  SafeEventEmitterProvider,
  UserInfo,
  WALLET_ADAPTERS,
  WalletInitializationError,
  WalletLoginError,
} from "@web3auth/base";
import { BaseProvider, BaseProviderConfig, BaseProviderState } from "@web3auth/base-provider";
import log from "loglevel";

import { getCustomAuthDefaultOptions } from "./config";
import CustomAuthStore from "./customAuthStore";
import type { CustomAuthAdapterOptions, CustomAuthResult, LoginSettings } from "./interface";
import { parseCustomAuthResult } from "./utils";

type ProviderFactory = BaseProvider<BaseProviderConfig, BaseProviderState, string>;

interface LoginParams {
  email: string;
  loginProvider: string;
}

const DEFAULT_CUSTOM_AUTH_RES: CustomAuthResult = {
  publicAddress: "",
  privateKey: "",
  email: "",
  name: "",
  profileImage: "",
  aggregateVerifier: "",
  verifier: "",
  verifierId: "",
  typeOfLogin: "google",
};

class CustomAuthAdapter extends BaseAdapter<LoginParams> {
  readonly name: string = WALLET_ADAPTERS.CUSTOM_AUTH;

  readonly namespace: AdapterNamespaceType = ADAPTER_NAMESPACES.MULTICHAIN;

  readonly type: ADAPTER_CATEGORY_TYPE = ADAPTER_CATEGORY.IN_APP;

  // should be overridden in constructor or from setChainConfig function
  // before calling init function.
  public currentChainNamespace: ChainNamespaceType = CHAIN_NAMESPACES.EIP155;

  public customAuthInstance!: CustomAuth;

  public status: ADAPTER_STATUS_TYPE = ADAPTER_STATUS.NOT_READY;

  public provider: SafeEventEmitterProvider | null = null;

  public readonly loginSettings: LoginSettings;

  private adapterSettings: CustomAuthArgs | null = null;

  private initSettings: InitParams;

  private providerFactory!: ProviderFactory;

  private store: CustomAuthStore;

  private customAuthResult: CustomAuthResult = {
    ...DEFAULT_CUSTOM_AUTH_RES,
  };

  constructor(params: CustomAuthAdapterOptions) {
    super();
    if (!params.loginSettings) {
      throw WalletInitializationError.invalidParams("loginSettings is required for customAuth adapter");
    }
    const defaultOptions = getCustomAuthDefaultOptions(params.chainConfig?.chainNamespace, params.chainConfig?.chainId);

    const adapterSettings = { ...defaultOptions.adapterSettings, ...params.adapterSettings };
    const loginSettings = { ...params.loginSettings };
    const initSettings = { ...defaultOptions.initSettings, ...params.initSettings };

    if (!adapterSettings.baseUrl) {
      throw WalletInitializationError.invalidParams("baseUrl is required in adapter settings");
    }
    if (!adapterSettings.redirectPathName) {
      throw WalletInitializationError.invalidParams("redirectPathName is required in adapter settings");
    }
    this.adapterSettings = adapterSettings as CustomAuthArgs;
    this.loginSettings = loginSettings;
    this.initSettings = initSettings;

    if (params.chainConfig?.chainNamespace) {
      this.currentChainNamespace = params.chainConfig?.chainNamespace;
    }
    const defaultChainIdConfig = defaultOptions.chainConfig ? defaultOptions.chainConfig : {};
    this.chainConfig = { ...defaultChainIdConfig, ...(params?.chainConfig || {}) } as CustomChainConfig;
    if (!this.chainConfig.rpcTarget) {
      throw WalletInitializationError.invalidParams("rpcTarget is required in chainConfig");
    }

    // syncing storage with custom auth result.
    this.store = CustomAuthStore.getInstance();
    this.customAuthResult = { ...this.customAuthResult, ...this.store.getStore() };
  }

  // should be called only before initialization.
  setChainConfig(customChainConfig: CustomChainConfig): void {
    if (this.status === ADAPTER_STATUS.READY) return;
    this.chainConfig = { ...customChainConfig };
    this.currentChainNamespace = customChainConfig.chainNamespace;
  }

  // should be called only before initialization.
  setAdapterSettings(adapterSettings: CustomAuthArgs): void {
    if (this.status === ADAPTER_STATUS.READY) return;
    const defaultOptions = getCustomAuthDefaultOptions();
    this.adapterSettings = { ...defaultOptions.adapterSettings, ...adapterSettings };
  }

  async init(options: AdapterInitOptions): Promise<void> {
    super.checkInitializationRequirements();
    if (!this.adapterSettings) throw WalletInitializationError.invalidParams("adapterSettings is required for customAuth adapter");
    if (!this.chainConfig) throw WalletInitializationError.invalidParams("chainConfig is required for customAuth adapter");
    this.customAuthInstance = new CustomAuth(this.adapterSettings);
    await this.customAuthInstance.init(this.initSettings);
    if (this.currentChainNamespace === CHAIN_NAMESPACES.SOLANA) {
      const { SolanaPrivateKeyProvider } = await import("@web3auth/solana-provider");
      this.providerFactory = new SolanaPrivateKeyProvider({ config: { chainConfig: this.chainConfig } });
    } else if (this.currentChainNamespace === CHAIN_NAMESPACES.EIP155) {
      const { EthereumPrivateKeyProvider } = await import("@web3auth/ethereum-provider");
      this.providerFactory = new EthereumPrivateKeyProvider({ config: { chainConfig: this.chainConfig } });
    } else {
      throw new Error(`Invalid chainNamespace: ${this.currentChainNamespace} found while connecting to wallet`);
    }
    this.status = ADAPTER_STATUS.CONNECTED;
    this.emit(ADAPTER_STATUS.READY, WALLET_ADAPTERS.CUSTOM_AUTH);

    try {
      // if adapter is already connected and cached then we can proceed to setup the provider
      if (this.customAuthResult.privateKey && options.autoConnect) {
        await this.setupProvider(this.providerFactory);
      }
      // if adapter is not connected then we should check if url contains redirect login result
      if (!this.customAuthResult.privateKey && this.isRedirectResultAvailable()) {
        await this.setupProvider(this.providerFactory);
      }
    } catch (error) {
      log.error("Failed to parse direct auth result", error);
      this.emit("ERRORED", error);
    }
  }

  async connect(params?: LoginParams): Promise<void> {
    super.checkConnectionRequirements();
    this.status = ADAPTER_STATUS.CONNECTING;
    this.emit(ADAPTER_STATUS.CONNECTING, { ...params, adapter: WALLET_ADAPTERS.CUSTOM_AUTH });
    try {
      await this.setupProvider(this.providerFactory, params);
      return;
    } catch (error) {
      this.emit(ADAPTER_STATUS.ERRORED, error);
      log.error("Error while connecting to custom auth", error);
      throw WalletLoginError.connectionError("Failed to login with CustomAuth");
    }
  }

  async disconnect(): Promise<void> {
    if (this.status !== ADAPTER_STATUS.CONNECTED) throw WalletLoginError.notConnectedError("Not connected with wallet");
    this.store.resetStore();
    // ready to be connected again
    this.status = ADAPTER_STATUS.READY;
    this.provider = null;
    this.customAuthResult = {
      ...DEFAULT_CUSTOM_AUTH_RES,
    };
    this.emit(ADAPTER_STATUS.DISCONNECTED);
  }

  async getUserInfo(): Promise<Partial<UserInfo>> {
    if (this.status !== ADAPTER_STATUS.CONNECTED) throw WalletLoginError.notConnectedError("Not connected with wallet");
    return {
      email: this.customAuthResult.email,
      name: this.customAuthResult.name,
      profileImage: this.customAuthResult.profileImage,
      verifier: this.customAuthResult.verifier,
      verifierId: this.customAuthResult.verifierId,
    };
  }

  private async isRedirectResultAvailable(): Promise<boolean> {
    const url = new URL(window.location.href);
    const hash = url.hash.substring(1);
    const queryParams: Record<string, string> = {};
    url.searchParams.forEach((value, key) => {
      queryParams[key] = value;
    });
    if (!hash && Object.keys(queryParams).length === 0) {
      return false;
    }
    const redirectResult = await this.customAuthInstance.getRedirectResult({
      replaceUrl: true,
      clearLoginDetails: true,
    });
    if (redirectResult.error) {
      log.error("Failed to parse direct auth result", redirectResult.error);
      if (redirectResult.error !== "Unsupported method type") {
        throw WalletLoginError.connectionError(redirectResult.error);
      }
      return false;
    }
    this.customAuthResult = parseCustomAuthResult(redirectResult);
    this._syncCustomauthResult(this.customAuthResult as Record<string, any>);
    if (this.customAuthResult.privateKey) {
      return true;
    }
    return false;
  }

  private async setupProvider(providerFactory: ProviderFactory, params?: LoginParams): Promise<void> {
    // eslint-disable-next-line no-async-promise-executor
    return new Promise(async (resolve, reject) => {
      const connectWithProvider = async (): Promise<void> => {
        const listener = ({ reason }: { reason: Error }) => {
          switch (reason?.message?.toLowerCase()) {
            case "user closed popup":
              reason = WalletInitializationError.windowClosed(reason.message);
              break;
            case "unable to open window":
              reason = WalletInitializationError.windowBlocked(reason.message);
              break;
          }
          reject(reason);
        };
        window.addEventListener("unhandledrejection", listener);
        // if user is already logged in.
        let finalPrivKey = this.customAuthResult?.privateKey;
        try {
          if (!finalPrivKey && params) {
            if (!this.loginSettings?.loginProviderConfig?.[params.loginProvider]) {
              throw new Error(`Login provider ${params.loginProvider} settings not found in loginSettings`);
            }
            const loginConfig = this.loginSettings?.loginProviderConfig?.[params.loginProvider];
            let result: TorusLoginResponse | TorusHybridAggregateLoginResponse | TorusAggregateLoginResponse;
            if (loginConfig.method === TORUS_METHOD.TRIGGER_LOGIN) {
              result = await this.customAuthInstance.triggerLogin(loginConfig.args as SingleLoginParams);
            } else if (loginConfig.method === TORUS_METHOD.TRIGGER_AGGREGATE_LOGIN) {
              result = await this.customAuthInstance.triggerAggregateLogin(loginConfig.args as AggregateLoginParams);
            } else if (loginConfig.method === TORUS_METHOD.TRIGGER_AGGREGATE_HYBRID_LOGIN) {
              result = await this.customAuthInstance.triggerHybridAggregateLogin(loginConfig.args as HybridAggregateLoginParams);
            } else {
              reject(WalletLoginError.connectionError(`Unsupported customauth method type: ${loginConfig.method}`));
              return;
            }

            if (this.adapterSettings?.uxMode === UX_MODE.POPUP) {
              const parsedResult = parseCustomAuthResult({ method: loginConfig.method, result, state: {}, args: loginConfig.args });
              this._syncCustomauthResult(parsedResult as Record<string, any>);
              finalPrivKey = parsedResult.privateKey;
            }
            return;
          }
          if (finalPrivKey) {
            if (this.currentChainNamespace === CHAIN_NAMESPACES.SOLANA) finalPrivKey = getED25519Key(finalPrivKey).sk.toString("hex");
            this.provider = await providerFactory.setupProvider(finalPrivKey);
            return;
          }
          return;
        } catch (err: unknown) {
          listener({ reason: err as Error });
          throw err;
        } finally {
          window.removeEventListener("unhandledrejection", listener);
        }
      };
      await connectWithProvider();
      if (this.provider) {
        this.status = ADAPTER_STATUS.CONNECTED;
        this.emit(ADAPTER_STATUS.CONNECTED, WALLET_ADAPTERS.CUSTOM_AUTH);
      }
      resolve();
    });
  }

  private _syncCustomauthResult(result?: Record<string, unknown>): void {
    if (result) {
      Object.keys(result).forEach((key: string) => {
        if (typeof result[key] === "string") {
          this.store.set(key, result[key] as string);
        }
      });
      this.customAuthResult = { ...this.customAuthResult, ...result };
    }
  }
}

export { CustomAuthAdapter as CustomauthAdapter };
