import { JsonRpcServer } from '@theia/core/lib/common/messaging/proxy-factory';
import { Board, Port } from './boards-service';
import { Event } from '@theia/core/lib/common/event';

export interface Status {}
export type OK = Status;
export interface ErrorStatus extends Status {
  readonly message: string;
}
export namespace Status {
  export function isOK(status: Status & { message?: string }): status is OK {
    return typeof status.message !== 'string';
  }
  export const OK: OK = {};
  export const NOT_CONNECTED: ErrorStatus = { message: 'Not connected.' };
  export const ALREADY_CONNECTED: ErrorStatus = {
    message: 'Already connected.',
  };
}

export const MonitorServicePath = '/services/serial-monitor';
export const MonitorService = Symbol('MonitorService');
export interface MonitorService extends JsonRpcServer<MonitorServiceClient> {
  connect(config: MonitorConfig): Promise<Status>;
  disconnect(): Promise<Status>;
  send(message: string): Promise<Status>;
}

export interface MonitorConfig {
  readonly board: Board;
  readonly port: Port;
  /**
   * Defaults to [`SERIAL`](MonitorConfig#ConnectionType#SERIAL).
   */
  readonly type?: MonitorConfig.ConnectionType;
  /**
   * Defaults to `9600`.
   */
  readonly baudRate?: MonitorConfig.BaudRate;
}
export namespace MonitorConfig {
  export type BaudRate =
    | 300
    | 1200
    | 2400
    | 4800
    | 9600
    | 19200
    | 38400
    | 57600
    | 115200;
  export namespace BaudRate {
    export const DEFAULT: BaudRate = 9600;
  }

  export enum ConnectionType {
    SERIAL = 0,
  }
}

export const MonitorServiceClient = Symbol('MonitorServiceClient');
export interface MonitorServiceClient {
  onError: Event<MonitorError>;
  onMessage: Event<string>;
  notifyError(event: MonitorError): void;
  notifyMessage(message: string): void;
}

export interface MonitorError {
  readonly message: string;
  /**
   * If no `code` is available, clients must reestablish the serial-monitor connection.
   */
  readonly code: number | undefined;
  readonly config: MonitorConfig;
}
export namespace MonitorError {
  export namespace ErrorCodes {
    /**
     * The frontend has refreshed the browser, for instance.
     */
    export const CLIENT_CANCEL = 1;
    /**
     * When detaching a physical device when the duplex channel is still opened.
     */
    export const DEVICE_NOT_CONFIGURED = 2;
    /**
     * Another serial monitor was opened on this port. For another electron-instance, Java IDE.
     */
    export const DEVICE_BUSY = 3;
  }
}
