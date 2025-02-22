import { sortBy } from "lodash";
import {
  loadScript,
  prefetchScript,
  getTemplateDepsOfStoryboard,
  getDllAndDepsOfStoryboard,
  asyncProcessStoryboard,
  scanBricksInBrickConf,
  scanRouteAliasInStoryboard,
  getDllAndDepsByResource,
  scanProcessorsInAny,
  CustomApiInfo,
} from "@next-core/brick-utils";
import i18next from "i18next";
import * as AuthSdk from "@next-sdk/auth-sdk";
import { UserAdminApi } from "@next-sdk/user-service-sdk";
import { ObjectMicroAppApi } from "@next-sdk/micro-app-sdk";
import { InstanceApi } from "@next-sdk/cmdb-sdk";
import {
  MountPoints,
  BootstrapData,
  RuntimeBootstrapData,
  InterceptorParams,
  MicroApp,
  UserInfo,
  MagicBrickConfig,
  FeatureFlags,
  RuntimeStoryboard,
  BrickConf,
  StoryboardMeta,
} from "@next-core/brick-types";
import { authenticate, isLoggedIn } from "../auth";
import {
  Router,
  MenuBar,
  AppBar,
  LoadingBar,
  registerCustomTemplate,
} from "./exports";
import { getHistory } from "../history";
import {
  RelatedApp,
  VisitedWorkspace,
  RecentApps,
  CustomApiOrchestration,
} from "./interfaces";
import { processBootstrapResponse } from "./processors";
import { brickTemplateRegistry } from "./TemplateRegistries";
import { listenDevtools } from "../devtools";
import { isCustomApiProvider } from "./CustomApis";
import { registerCustomApi, CUSTOM_API_PROVIDER } from "../providers/CustomApi";

export class Kernel {
  public mountPoints: MountPoints;
  public bootstrapData: RuntimeBootstrapData;
  public menuBar: MenuBar;
  public appBar: AppBar;
  public loadingBar: LoadingBar;
  public router: Router;
  public currentApp: MicroApp;
  public previousApp: MicroApp;
  public nextApp: MicroApp;
  public currentUrl: string;
  public workspaceStack: VisitedWorkspace[] = [];
  public allUserMapPromise: Promise<Map<string, UserInfo>> = Promise.resolve(
    new Map()
  );
  public allMagicBrickConfigMapPromise: Promise<
    Map<string, MagicBrickConfig>
  > = Promise.resolve(new Map());
  public nextAppMeta: StoryboardMeta;
  private allRelatedAppsPromise: Promise<RelatedApp[]> = Promise.resolve([]);
  public allMicroAppApiOrchestrationPromise: Promise<
    Map<string, CustomApiOrchestration>
  > = Promise.resolve(new Map());
  private providerRepository = new Map<string, HTMLElement>();
  private loadUsersStarted = false;
  private loadMagicBrickConfigStarted = false;

  async bootstrap(mountPoints: MountPoints): Promise<void> {
    this.mountPoints = mountPoints;
    await Promise.all([this.loadCheckLogin(), this.loadMicroApps()]);
    if (this.bootstrapData.storyboards.length === 0) {
      throw new Error("Storyboard is empty");
    }
    if (isLoggedIn()) {
      this.loadSharedData();
    }
    this.menuBar = new MenuBar(this);
    this.appBar = new AppBar(this);
    this.loadingBar = new LoadingBar(this);
    this.router = new Router(this);
    await Promise.all([
      await this.menuBar.bootstrap(),
      await this.appBar.bootstrap(),
      await this.loadingBar.bootstrap(),
    ]);
    // Router need those bars above to be ready.
    await this.router.bootstrap();
    this.authGuard();
    listenDevtools();
  }

  private authGuard(): void {
    // Listen messages from legacy Console-W,
    // Redirect to login page if received an `auth.guard` message.
    window.addEventListener("message", (event: MessageEvent): void => {
      if (event.origin !== window.location.origin) {
        return;
      }
      const data = Object.assign({}, event.data);
      if (data.type === "auth.guard") {
        const history = getHistory();
        const ssoEnabled = this.getFeatureFlags()["sso-enabled"];
        history.push(ssoEnabled ? "/sso-auth/login" : "/auth/login", {
          from: history.location,
        });
      }
    });
  }

  private async loadCheckLogin(): Promise<void> {
    const auth = await AuthSdk.checkLogin();
    if (auth.loggedIn) {
      authenticate(auth);
    }
  }

  async loadMicroApps(
    params?: { check_login?: boolean },
    interceptorParams?: InterceptorParams
  ): Promise<void> {
    const d = await AuthSdk.bootstrap<BootstrapData>(
      {
        brief: true,
        ...params,
      },
      {
        interceptorParams,
      }
    );
    const bootstrapResponse = Object.assign(
      {
        templatePackages: [],
      },
      d
    );
    // Merge `app.defaultConfig` and `app.userConfig` to `app.config`.
    processBootstrapResponse(bootstrapResponse);
    this.bootstrapData = {
      ...bootstrapResponse,
      microApps: bootstrapResponse.storyboards
        .map((storyboard) => storyboard.app)
        .filter(Boolean),
    };
  }

  async fulfilStoryboard(storyboard: RuntimeStoryboard): Promise<void> {
    if (storyboard.$$fulfilled) {
      return;
    }
    const { routes, meta } = await AuthSdk.getAppStoryboard(storyboard.app.id);
    Object.assign(storyboard, { routes, meta, $$fulfilled: true });
    storyboard.app.$$routeAliasMap = scanRouteAliasInStoryboard(storyboard);

    if (meta?.i18n) {
      // Prefix to avoid conflict between brick package's i18n namespace.
      const i18nNamespace = `$app-${storyboard.app.id}`;
      // Support any language in `meta.i18n`.
      Object.entries(meta.i18n).forEach(([lang, resources]) => {
        i18next.addResourceBundle(lang, i18nNamespace, resources);
      });
    }
  }

  async loadDepsOfStoryboard(storyboard: RuntimeStoryboard): Promise<void> {
    const { brickPackages, templatePackages } = this.bootstrapData;

    if (storyboard.dependsAll) {
      const dllHash: Record<string, string> = (window as any).DLL_HASH || {};
      const reactDnd = "react-dnd";
      // istanbul ignore else
      if (dllHash[reactDnd]) {
        await loadScript(`dll-of-${reactDnd}.js?${dllHash[reactDnd]}`);
      }
      // `loadScript` is auto cached, no need to filter out `react-dnd`.
      await loadScript(
        Object.entries(dllHash).map(
          ([name, hash]) => `dll-of-${name}.js?${hash}`
        )
      );
      await loadScript(
        brickPackages
          .map((item) => item.filePath)
          .concat(templatePackages.map((item) => item.filePath))
      );
    } else {
      // 先加载模板
      const templateDeps = getTemplateDepsOfStoryboard(
        storyboard,
        templatePackages
      );
      await loadScript(templateDeps);
      // 加载模板后才能加工得到最终的构件表
      const result = getDllAndDepsOfStoryboard(
        await asyncProcessStoryboard(
          storyboard,
          brickTemplateRegistry,
          templatePackages
        ),
        brickPackages,
        {
          ignoreBricksInUnusedCustomTemplates: true,
        }
      );
      await loadScriptOfDll(result.dll);
      await loadScript(result.deps);
    }
  }

  prefetchDepsOfStoryboard(storyboard: RuntimeStoryboard): void {
    if (storyboard.$$depsProcessed) {
      return;
    }
    const { brickPackages, templatePackages } = this.bootstrapData;
    const templateDeps = getTemplateDepsOfStoryboard(
      storyboard,
      templatePackages
    );
    prefetchScript(templateDeps);
    const result = getDllAndDepsOfStoryboard(storyboard, brickPackages);
    prefetchScript(result.dll.concat(result.deps));
    storyboard.$$depsProcessed = true;
  }

  registerCustomTemplatesInStoryboard(storyboard: RuntimeStoryboard): void {
    if (!storyboard.$$registerCustomTemplateProcessed) {
      // 注册自定义模板
      if (Array.isArray(storyboard.meta?.customTemplates)) {
        for (const tpl of storyboard.meta.customTemplates) {
          registerCustomTemplate(
            tpl.name,
            {
              bricks: tpl.bricks,
              proxy: tpl.proxy,
            },
            storyboard.app?.id
          );
        }
      }
      // 每个 storyboard 仅注册一次custom-template
      storyboard.$$registerCustomTemplateProcessed = true;
    }
  }

  async loadDynamicBricksInBrickConf(brickConf: BrickConf): Promise<void> {
    // Notice: `brickConf` contains runtime data,
    // which may contains recursive ref,
    // which could cause stack overflow while traversing.
    const bricks = scanBricksInBrickConf(brickConf);
    const processors = scanProcessorsInAny(brickConf);
    await this.loadDynamicBricks(bricks, processors);
  }

  async loadDynamicBricks(
    bricks: string[],
    processors?: string[]
  ): Promise<void> {
    // Try to load deps for dynamic added bricks.
    const { dll, deps } = getDllAndDepsByResource(
      {
        bricks: bricks.filter(
          // Only try to load undefined custom elements.
          (item) => !customElements.get(item)
        ),
        processors,
      },
      this.bootstrapData.brickPackages
    );
    await loadScriptOfDll(dll);
    await loadScript(deps);
  }

  async loadEditorBricks(editorBricks: string[]): Promise<void> {
    const { dll, deps } = getDllAndDepsByResource(
      {
        editorBricks: editorBricks.filter(
          // Only try to load undefined custom elements.
          (item) => !customElements.get(item)
        ),
      },
      this.bootstrapData.brickPackages
    );
    await loadScriptOfDll(dll);
    await loadScript(deps);
  }

  firstRendered(): void {
    setTimeout(() => {
      document.body.classList.add("first-rendered");
    });
  }

  /**
   * 展开/收起顶栏、侧栏
   * @param visible 是否显示
   */
  toggleBars(visible: boolean): void {
    document.body.classList.toggle("bars-hidden", !visible);
  }

  /**
   * 重置顶栏、侧栏
   */
  unsetBars({
    appChanged,
    legacy,
  }: { appChanged?: boolean; legacy?: "iframe" } = {}): void {
    this.toggleBars(true);
    if (appChanged) {
      this.menuBar.resetAppMenu();
    }
    if (legacy !== "iframe" || appChanged) {
      // 对于 Legacy 页面，仅当切换应用时重设面包屑。
      this.appBar.setBreadcrumb(null);
    }
    this.appBar.setPageTitle(null);
  }

  toggleLegacyIframe(visible: boolean): void {
    document.body.classList.toggle("show-legacy-iframe", visible);
  }

  loadSharedData(): void {
    this.loadRelatedAppsAsync();
  }

  loadUsersAsync(): void {
    if (!this.loadUsersStarted) {
      this.loadUsersStarted = true;
      this.allUserMapPromise = this.loadUsers();
    }
  }

  private async loadUsers(): Promise<Map<string, UserInfo>> {
    const allUserMap: Map<string, UserInfo> = new Map();
    try {
      const query = { state: "valid" };
      const fields = {
        name: true,
        nickname: true,
        user_email: true,
        user_tel: true,
        user_icon: true,
        user_memo: true,
      };
      const allUserInfo = (
        await UserAdminApi.searchAllUsersInfo({
          query,
          fields,
        })
      ).list as UserInfo[];
      for (const user of allUserInfo) {
        allUserMap.set(user.name, user);
      }
    } catch (error) {
      // eslint-disable-next-line no-console
      console.warn("Load users error:", error);
    }
    return allUserMap;
  }

  loadMicroAppApiOrchestrationAsync(usedCustomApis: CustomApiInfo[]): void {
    this.allMicroAppApiOrchestrationPromise = this.loadMicroAppApiOrchestration(
      usedCustomApis
    );
  }

  async getMicroAppApiOrchestrationMapAsync(): Promise<
    Map<string, CustomApiOrchestration>
  > {
    return await this.allMicroAppApiOrchestrationPromise;
  }

  private async loadMicroAppApiOrchestration(
    usedCustomApis: CustomApiInfo[]
  ): Promise<Map<string, CustomApiOrchestration>> {
    const allMicroAppApiOrchestrationMap: Map<
      string,
      CustomApiOrchestration
    > = new Map();
    if (usedCustomApis.length) {
      try {
        const allMicroAppApiOrchestration = (
          await InstanceApi.postSearch("MICRO_APP_API_ORCHESTRATION", {
            page: 1,
            page_size: usedCustomApis.length,
            fields: {
              name: true,
              namespace: true,
              contract: true,
              config: true,
              type: true,
            },
            query: {
              $or: usedCustomApis,
            },
          })
        ).list as CustomApiOrchestration[];
        for (const api of allMicroAppApiOrchestration) {
          allMicroAppApiOrchestrationMap.set(
            `${api.namespace}@${api.name}`,
            api
          );
        }
      } catch (error) {
        // eslint-disable-next-line no-console
        console.warn("Load custom api orchestration error:", error);
      }
    }
    return allMicroAppApiOrchestrationMap;
  }

  loadMagicBrickConfigAsync(): void {
    if (!this.loadMagicBrickConfigStarted) {
      this.loadMagicBrickConfigStarted = true;
      this.allMagicBrickConfigMapPromise = this.loadMagicBrickConfig();
    }
  }

  private async loadMagicBrickConfig(): Promise<Map<string, MagicBrickConfig>> {
    const allMagicBrickConfigMap: Map<string, MagicBrickConfig> = new Map();
    try {
      const allMagicBrickConfig = (
        await InstanceApi.postSearch("_BRICK_MAGIC", {
          page: 1,
          // TODO(Lynette): 暂时设置3000，待后台提供全量接口
          page_size: 3000,
          fields: {
            "*": true,
          },
        })
      ).list as MagicBrickConfig[];
      for (const config of allMagicBrickConfig) {
        allMagicBrickConfigMap.set(config.selector, config);
      }
    } catch (error) {
      // eslint-disable-next-line no-console
      console.warn("Load magic brick config error:", error);
    }
    return allMagicBrickConfigMap;
  }

  private loadRelatedAppsAsync(): void {
    this.allRelatedAppsPromise = this.loadRelatedApps();
  }

  private async loadRelatedApps(): Promise<RelatedApp[]> {
    let relatedApps: RelatedApp[] = [];
    try {
      relatedApps = (await ObjectMicroAppApi.getObjectMicroAppList()).list;
    } catch (error) {
      // eslint-disable-next-line no-console
      console.warn("Load related apps error:", error);
    }
    return relatedApps;
  }

  async getRelatedAppsAsync(appId: string): Promise<RelatedApp[]> {
    if (!appId) {
      return [];
    }
    const allRelatedApps = await this.allRelatedAppsPromise;
    const thisApp = allRelatedApps.find((item) => item.microAppId === appId);
    if (!thisApp) {
      return [];
    }
    return sortBy(
      allRelatedApps.filter((item) => item.objectId === thisApp.objectId),
      ["order"]
    );
  }

  async updateWorkspaceStack(): Promise<void> {
    if (this.currentApp && this.currentApp.id) {
      const workspace: VisitedWorkspace = {
        appId: this.currentApp.id,
        appName: this.currentApp.name,
        appLocaleName: this.currentApp.localeName,
        url: this.currentUrl,
      };
      if (this.workspaceStack.length > 0) {
        const previousWorkspace = this.workspaceStack[
          this.workspaceStack.length - 1
        ];
        const relatedApps = await this.getRelatedAppsAsync(
          previousWorkspace.appId
        );
        if (
          relatedApps.some((item) => item.microAppId === this.currentApp.id)
        ) {
          Object.assign(previousWorkspace, workspace);
          return;
        }
      }

      const relatedApps = await this.getRelatedAppsAsync(this.currentApp.id);
      if (relatedApps.length > 0) {
        this.workspaceStack.push(workspace);
        return;
      }
    }
    this.workspaceStack = [];
  }

  getPreviousWorkspace(): VisitedWorkspace {
    if (this.workspaceStack.length > 1) {
      return this.workspaceStack[this.workspaceStack.length - 2];
    }
  }

  popWorkspaceStack(): void {
    this.workspaceStack.pop();
  }

  getRecentApps(): RecentApps {
    return {
      previousApp: this.previousApp,
      currentApp: this.currentApp,
      previousWorkspace: this.getPreviousWorkspace(),
    };
  }

  getFeatureFlags(): FeatureFlags {
    return Object.assign({}, this.bootstrapData?.settings?.featureFlags);
  }

  async getProviderBrick(provider: string): Promise<HTMLElement> {
    if (isCustomApiProvider(provider)) {
      provider = CUSTOM_API_PROVIDER;
    }

    if (this.providerRepository.has(provider)) {
      return this.providerRepository.get(provider);
    }

    if (provider === CUSTOM_API_PROVIDER && !customElements.get(provider)) {
      registerCustomApi();
    }

    await this.loadDynamicBricks([provider]);

    if (!customElements.get(provider)) {
      throw new Error(`Provider not defined: "${provider}".`);
    }
    const brick = document.createElement(provider);
    this.providerRepository.set(provider, brick);
    return brick;
  }
}

// Since `@next-dll/editor-bricks-helper` depends on `@next-dll/react-dnd`,
// always load react-dnd before loading editor-bricks-helper.
async function loadScriptOfDll(dlls: string[]): Promise<void> {
  if (dlls.some((dll) => dll.startsWith("dll-of-editor-bricks-helper.js"))) {
    const dllHash: Record<string, string> = (window as any).DLL_HASH || {};
    await loadScript(`dll-of-react-dnd.js?${dllHash["react-dnd"]}`);
  }
  // `loadScript` is auto cached, no need to filter out `react-dnd`.
  await loadScript(dlls);
}
