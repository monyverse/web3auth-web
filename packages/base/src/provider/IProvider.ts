import { JRPCRequest, SafeEventEmitter } from "@toruslabs/openlogin-jrpc";

export type SendCallBack<U> = (err: unknown, providerRes: U) => void;
export interface RequestArguments {
  method: string;
  params?: unknown[] | object;
}

export type Maybe<T> = T | Partial<T> | null | undefined;

export interface SafeEventEmitterProvider extends SafeEventEmitter {
  sendAsync: <T, U>(req: JRPCRequest<T>) => Promise<U>;
  send: <T, U>(req: JRPCRequest<T>, callback: SendCallBack<U>) => void;
  request: <T>(args: RequestArguments) => Promise<Maybe<T>>;
}

export const PROVIDER_EVENTS = {
  INITIALIZED: "initialized",
  ERRORED: "errored",
};
