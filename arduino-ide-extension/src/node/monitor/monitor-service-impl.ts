import { ClientDuplexStream } from '@grpc/grpc-js';
import { TextEncoder } from 'util';
import { injectable, inject, named } from 'inversify';
import { Struct } from 'google-protobuf/google/protobuf/struct_pb';
import { Emitter } from '@theia/core/lib/common/event';
import { ILogger } from '@theia/core/lib/common/logger';
import {
  MonitorService,
  MonitorServiceClient,
  MonitorConfig,
  MonitorError,
  Status,
} from '../../common/protocol/monitor-service';
import {
  StreamingOpenRequest,
  StreamingOpenResponse,
  MonitorConfig as GrpcMonitorConfig,
} from '../cli-protocol/cc/arduino/cli/monitor/v1/monitor_pb';
import { MonitorClientProvider } from './monitor-client-provider';
import { Board, Port } from '../../common/protocol/boards-service';
import * as WebSocket from 'ws';

interface ErrorWithCode extends Error {
  readonly code: number;
}
namespace ErrorWithCode {
  export function toMonitorError(
    error: Error,
    config: MonitorConfig
  ): MonitorError {
    const { message } = error;
    let code = undefined;
    if (is(error)) {
      // TODO: const `mapping`. Use regex for the `message`.
      const mapping = new Map<string, number>();
      mapping.set(
        '1 CANCELLED: Cancelled on client',
        MonitorError.ErrorCodes.CLIENT_CANCEL
      );
      mapping.set(
        '2 UNKNOWN: device not configured',
        MonitorError.ErrorCodes.DEVICE_NOT_CONFIGURED
      );
      mapping.set(
        '2 UNKNOWN: error opening serial monitor: Serial port busy',
        MonitorError.ErrorCodes.DEVICE_BUSY
      );
      code = mapping.get(message);
    }
    return {
      message,
      code,
      config,
    };
  }
  function is(error: Error & { code?: number }): error is ErrorWithCode {
    return typeof error.code === 'number';
  }
}

@injectable()
export class MonitorServiceImpl implements MonitorService {
  @inject(ILogger)
  @named('monitor-service')
  protected readonly logger: ILogger;

  @inject(MonitorClientProvider)
  protected readonly monitorClientProvider: MonitorClientProvider;

  protected client?: MonitorServiceClient;
  protected connection?: {
    duplex: ClientDuplexStream<StreamingOpenRequest, StreamingOpenResponse>;
    config: MonitorConfig;
  };
  protected messages: string[] = [];
  protected onMessageDidReadEmitter = new Emitter<void>();

  setClient(client: MonitorServiceClient | undefined): void {
    this.client = client;
  }

  dispose(): void {
    this.logger.info('>>> Disposing monitor service...');
    if (this.connection) {
      this.disconnect();
    }
    this.logger.info('<<< Disposed monitor service.');
    this.client = undefined;
  }

  async connect(config: MonitorConfig): Promise<Status> {
    this.logger.info(
      `>>> Creating serial monitor connection for ${Board.toString(
        config.board
      )} on port ${Port.toString(config.port)}...`
    );
    if (this.connection) {
      return Status.ALREADY_CONNECTED;
    }
    const client = await this.monitorClientProvider.client();
    if (!client) {
      return Status.NOT_CONNECTED;
    }
    if (client instanceof Error) {
      return { message: client.message };
    }
    const duplex = client.streamingOpen();
    this.connection = { duplex, config };

    duplex.on(
      'error',
      ((error: Error) => {
        const monitorError = ErrorWithCode.toMonitorError(error, config);
        this.disconnect(monitorError).then(() => {
          if (this.client) {
            this.client.notifyError(monitorError);
          }
          if (monitorError.code === undefined) {
            // Log the original, unexpected error.
            this.logger.error(error);
          }
        });
      }).bind(this)
    );

    const ws = new WebSocket.Server({ port: 0 });
    const address: any = ws.address();
    this.client?.notifyMessage(address.port);
    let wsConn: WebSocket | null = null;
    ws.on('connection', (ws) => {
      wsConn = ws;
    });

    const flushMessagesToFrontend = () => {
      if (this.messages.length) {
        wsConn?.send(JSON.stringify(this.messages));
        this.messages = [];
      }
    };

    // empty the queue every 16ms (~60fps)
    setInterval(flushMessagesToFrontend, 32);

    // converts 'ab\nc\nd' => [ab\n,c\n,d]
    const stringToArray = (string: string, separator = '\n') => {
      const retArray: string[] = [];

      let prevChar = separator;

      for (let i = 0; i < string.length; i++) {
        const currChar = string[i];

        if (prevChar === separator) {
          retArray.push(currChar);
        } else {
          const lastWord = retArray[retArray.length - 1];
          retArray[retArray.length - 1] = lastWord + currChar;
        }

        prevChar = currChar;
      }
      return retArray;
    };

    duplex.on(
      'data',
      ((resp: StreamingOpenResponse) => {
        const raw = resp.getData();
        const message =
          typeof raw === 'string' ? raw : new TextDecoder('utf8').decode(raw);

        // split the message if it contains more lines
        const messages = stringToArray(message);
        this.messages.push(...messages);
      }).bind(this)
    );

    const { type, port } = config;
    const req = new StreamingOpenRequest();
    const monitorConfig = new GrpcMonitorConfig();
    monitorConfig.setType(this.mapType(type));
    monitorConfig.setTarget(port.address);
    if (config.baudRate !== undefined) {
      monitorConfig.setAdditionalConfig(
        Struct.fromJavaScript({ BaudRate: config.baudRate })
      );
    }
    req.setConfig(monitorConfig);

    return new Promise<Status>((resolve) => {
      if (this.connection) {
        this.connection.duplex.write(req, () => {
          this.logger.info(
            `<<< Serial monitor connection created for ${Board.toString(
              config.board,
              { useFqbn: false }
            )} on port ${Port.toString(config.port)}.`
          );
          resolve(Status.OK);
        });
        return;
      }
      this.disconnect().then(() => resolve(Status.NOT_CONNECTED));
    });
  }

  async disconnect(reason?: MonitorError): Promise<Status> {
    try {
      if (
        !this.connection &&
        reason &&
        reason.code === MonitorError.ErrorCodes.CLIENT_CANCEL
      ) {
        return Status.OK;
      }
      this.logger.info('>>> Disposing monitor connection...');
      if (!this.connection) {
        this.logger.warn('<<< Not connected. Nothing to dispose.');
        return Status.NOT_CONNECTED;
      }
      const { duplex, config } = this.connection;
      duplex.cancel();
      this.logger.info(
        `<<< Disposed monitor connection for ${Board.toString(config.board, {
          useFqbn: false,
        })} on port ${Port.toString(config.port)}.`
      );
      this.connection = undefined;
      return Status.OK;
    } finally {
      this.messages.length = 0;
    }
  }

  async send(message: string): Promise<Status> {
    if (!this.connection) {
      return Status.NOT_CONNECTED;
    }
    const req = new StreamingOpenRequest();
    req.setData(new TextEncoder().encode(message));
    return new Promise<Status>((resolve) => {
      if (this.connection) {
        this.connection.duplex.write(req, () => {
          resolve(Status.OK);
        });
        return;
      }
      this.disconnect().then(() => resolve(Status.NOT_CONNECTED));
    });
  }

  protected mapType(
    type?: MonitorConfig.ConnectionType
  ): GrpcMonitorConfig.TargetType {
    switch (type) {
      case MonitorConfig.ConnectionType.SERIAL:
        return GrpcMonitorConfig.TargetType.TARGET_TYPE_SERIAL;
      default:
        return GrpcMonitorConfig.TargetType.TARGET_TYPE_SERIAL;
    }
  }
}
