import { inject, injectable } from 'inversify';
import { remote } from 'electron';
import { MenuModelRegistry } from '@theia/core/lib/common/menu';
import {
  DisposableCollection,
  Disposable,
} from '@theia/core/lib/common/disposable';
import { firstToUpperCase } from '../../common/utils';
import { BoardsConfig } from '../boards/boards-config';
import { MainMenuManager } from '../../common/main-menu-manager';
import { BoardsListWidget } from '../boards/boards-list-widget';
import { NotificationCenter } from '../notification-center';
import { BoardsServiceProvider } from '../boards/boards-service-provider';
import {
  ArduinoMenus,
  PlaceholderMenuNode,
  unregisterSubmenu,
} from '../menu/arduino-menus';
import {
  BoardsService,
  InstalledBoardWithPackage,
  AvailablePorts,
  Port,
} from '../../common/protocol';
import { SketchContribution, Command, CommandRegistry } from './contribution';
import { nls } from '@theia/core/lib/browser/nls';

@injectable()
export class BoardSelection extends SketchContribution {
  @inject(CommandRegistry)
  protected readonly commandRegistry: CommandRegistry;

  @inject(MainMenuManager)
  protected readonly mainMenuManager: MainMenuManager;

  @inject(MenuModelRegistry)
  protected readonly menuModelRegistry: MenuModelRegistry;

  @inject(NotificationCenter)
  protected readonly notificationCenter: NotificationCenter;

  @inject(BoardsService)
  protected readonly boardsService: BoardsService;

  @inject(BoardsServiceProvider)
  protected readonly boardsServiceProvider: BoardsServiceProvider;

  protected readonly toDisposeBeforeMenuRebuild = new DisposableCollection();

  registerCommands(registry: CommandRegistry): void {
    registry.registerCommand(BoardSelection.Commands.GET_BOARD_INFO, {
      execute: async () => {
        const { selectedBoard, selectedPort } =
          this.boardsServiceProvider.boardsConfig;
        if (!selectedBoard) {
          this.messageService.info(
            nls.localize(
              'arduino/board/selectBoardForInfo',
              'Please select a board to obtain board info.'
            )
          );
          return;
        }
        if (!selectedBoard.fqbn) {
          this.messageService.info(
            nls.localize(
              'arduino/board/platformMissing',
              "The platform for the selected '{0}' board is not installed.",
              selectedBoard.name
            )
          );
          return;
        }
        if (!selectedPort) {
          this.messageService.info(
            nls.localize(
              'arduino/board/selectPortForInfo',
              'Please select a port to obtain board info.'
            )
          );
          return;
        }
        const boardDetails = await this.boardsService.getBoardDetails({
          fqbn: selectedBoard.fqbn,
        });
        if (boardDetails) {
          const { VID, PID } = boardDetails;
          const detail = `BN: ${selectedBoard.name}
VID: ${VID}
PID: ${PID}`;
          await remote.dialog.showMessageBox(remote.getCurrentWindow(), {
            message: nls.localize('arduino/board/boardInfo', 'Board Info'),
            title: nls.localize('arduino/board/boardInfo', 'Board Info'),
            type: 'info',
            detail,
            buttons: [nls.localize('vscode/issueMainService/ok', 'OK')],
          });
        }
      },
    });
  }

  onStart(): void {
    this.updateMenus();
    this.notificationCenter.onPlatformInstalled(this.updateMenus.bind(this));
    this.notificationCenter.onPlatformUninstalled(this.updateMenus.bind(this));
    this.boardsServiceProvider.onBoardsConfigChanged(
      this.updateMenus.bind(this)
    );
    this.boardsServiceProvider.onAvailableBoardsChanged(
      this.updateMenus.bind(this)
    );
  }

  protected async updateMenus(): Promise<void> {
    const [installedBoards, availablePorts, config] = await Promise.all([
      this.installedBoards(),
      this.boardsService.getState(),
      this.boardsServiceProvider.boardsConfig,
    ]);
    this.rebuildMenus(installedBoards, availablePorts, config);
  }

  protected rebuildMenus(
    installedBoards: InstalledBoardWithPackage[],
    availablePorts: AvailablePorts,
    config: BoardsConfig.Config
  ): void {
    this.toDisposeBeforeMenuRebuild.dispose();

    // Boards submenu
    const boardsSubmenuPath = [
      ...ArduinoMenus.TOOLS__BOARD_SELECTION_GROUP,
      '1_boards',
    ];
    const boardsSubmenuLabel = config.selectedBoard?.name;
    // Note: The submenu order starts from `100` because `Auto Format`, `Serial Monitor`, etc starts from `0` index.
    // The board specific items, and the rest, have order with `z`. We needed something between `0` and `z` with natural-order.
    this.menuModelRegistry.registerSubmenu(
      boardsSubmenuPath,
      nls.localize('arduino/board/board', 'Board{0}', !!boardsSubmenuLabel ? `: "${boardsSubmenuLabel}"` : ''),
      { order: '100' }
    );
    this.toDisposeBeforeMenuRebuild.push(
      Disposable.create(() =>
        unregisterSubmenu(boardsSubmenuPath, this.menuModelRegistry)
      )
    );

    // Ports submenu
    const portsSubmenuPath = [
      ...ArduinoMenus.TOOLS__BOARD_SELECTION_GROUP,
      '2_ports',
    ];
    const portsSubmenuLabel = config.selectedPort?.address;
    this.menuModelRegistry.registerSubmenu(
      portsSubmenuPath,
      nls.localize('arduino/board/port', 'Port{0}', portsSubmenuLabel ? `: "${portsSubmenuLabel}"` : ''),
      { order: '101' }
    );
    this.toDisposeBeforeMenuRebuild.push(
      Disposable.create(() =>
        unregisterSubmenu(portsSubmenuPath, this.menuModelRegistry)
      )
    );

    const getBoardInfo = {
      commandId: BoardSelection.Commands.GET_BOARD_INFO.id,
      label: nls.localize('arduino/board/getBoardInfo', 'Get Board Info'),
      order: '103',
    };
    this.menuModelRegistry.registerMenuAction(
      ArduinoMenus.TOOLS__BOARD_SELECTION_GROUP,
      getBoardInfo
    );
    this.toDisposeBeforeMenuRebuild.push(
      Disposable.create(() =>
        this.menuModelRegistry.unregisterMenuAction(getBoardInfo)
      )
    );

    const boardsManagerGroup = [...boardsSubmenuPath, '0_manager'];
    const boardsPackagesGroup = [...boardsSubmenuPath, '1_packages'];

    this.menuModelRegistry.registerMenuAction(boardsManagerGroup, {
      commandId: `${BoardsListWidget.WIDGET_ID}:toggle`,
      label: `${BoardsListWidget.WIDGET_LABEL}...`,
    });

    // Installed boards
    for (const board of installedBoards) {
      const { packageId, packageName, fqbn, name, manuallyInstalled } = board;

      const packageLabel =
        packageName +
        `${manuallyInstalled
          ? nls.localize('arduino/board/inSketchbook', ' (in Sketchbook)')
          : ''
        }`;
      // Platform submenu
      const platformMenuPath = [...boardsPackagesGroup, packageId];
      // Note: Registering the same submenu twice is a noop. No need to group the boards per platform.
      this.menuModelRegistry.registerSubmenu(platformMenuPath, packageLabel, {
        order: packageName.toLowerCase(),
      });

      const id = `arduino-select-board--${fqbn}`;
      const command = { id };
      const handler = {
        execute: () => {
          if (
            fqbn !== this.boardsServiceProvider.boardsConfig.selectedBoard?.fqbn
          ) {
            this.boardsServiceProvider.boardsConfig = {
              selectedBoard: {
                name,
                fqbn,
                port: this.boardsServiceProvider.boardsConfig.selectedBoard
                  ?.port, // TODO: verify!
              },
              selectedPort:
                this.boardsServiceProvider.boardsConfig.selectedPort,
            };
          }
        },
        isToggled: () =>
          fqbn === this.boardsServiceProvider.boardsConfig.selectedBoard?.fqbn,
      };

      // Board menu
      const menuAction = { commandId: id, label: name };
      this.commandRegistry.registerCommand(command, handler);
      this.toDisposeBeforeMenuRebuild.push(
        Disposable.create(() => this.commandRegistry.unregisterCommand(command))
      );
      this.menuModelRegistry.registerMenuAction(platformMenuPath, menuAction);
      // Note: we do not dispose the menu actions individually. Calling `unregisterSubmenu` on the parent will wipe the children menu nodes recursively.
    }

    // Installed ports
    const registerPorts = (protocol: string, ports: AvailablePorts) => {
      const addresses = Object.keys(ports);
      if (!addresses.length) {
        return;
      }

      // Register placeholder for protocol
      const menuPath = [...portsSubmenuPath, protocol];
      const placeholder = new PlaceholderMenuNode(
        menuPath,
        `${firstToUpperCase(protocol)} ports`
      );
      this.menuModelRegistry.registerMenuNode(menuPath, placeholder);
      this.toDisposeBeforeMenuRebuild.push(
        Disposable.create(() =>
          this.menuModelRegistry.unregisterMenuNode(placeholder.id)
        )
      );

      for (const address of Object.keys(ports)) {
        const [port, boards] = ports[address];
        if (!boards.length) {
          boards.push({ name: '' });
        }
        for (const { name, fqbn } of boards) {
          const id = `arduino-select-port--${address}${fqbn ? `--${fqbn}` : ''}`;
          const command = { id };
          const handler = {
            execute: () => {
              if (!Port.equals(port, this.boardsServiceProvider.boardsConfig.selectedPort)) {
                this.boardsServiceProvider.boardsConfig = {
                  selectedBoard:
                    this.boardsServiceProvider.boardsConfig.selectedBoard,
                  selectedPort: port,
                };
              }
            },
            isToggled: () => Port.equals(port, this.boardsServiceProvider.boardsConfig.selectedPort),
          }
          const label = `${address}${name ? ` (${name})` : ''}`;
          const menuAction = {
            commandId: id,
            label,
            order: `1${label}`, // `1` comes after the placeholder which has order `0`
          };
          this.commandRegistry.registerCommand(command, handler);
          this.toDisposeBeforeMenuRebuild.push(
            Disposable.create(() =>
              this.commandRegistry.unregisterCommand(command)
            )
          );
          this.menuModelRegistry.registerMenuAction(menuPath, menuAction);
        }
      }
    };

    const grouped = AvailablePorts.byProtocol(availablePorts);
    // We first show serial and network ports, then all the rest
    ["serial", "network"].forEach(protocol => {
      const ports = grouped.get(protocol);
      if (ports) {
        registerPorts(protocol, ports);
      }
    });
    grouped.forEach((ports, protocol) => {
      if (protocol === "serial" || protocol === "network") {
        return;
      }
      registerPorts(protocol, ports);
    })

    this.mainMenuManager.update();
  }

  protected async installedBoards(): Promise<InstalledBoardWithPackage[]> {
    const allBoards = await this.boardsService.searchBoards({});
    return allBoards.filter(InstalledBoardWithPackage.is);
  }
}
export namespace BoardSelection {
  export namespace Commands {
    export const GET_BOARD_INFO: Command = { id: 'arduino-get-board-info' };
  }
}
