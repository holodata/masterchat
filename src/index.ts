import { Buffer } from "buffer";
import { EventEmitter } from "events";
import { buildAuthHeaders, Credentials } from "./auth";
import * as constants from "./constants";
import {
  AbortError,
  AccessDeniedError,
  DisabledChatError,
  InvalidArgumentError,
  MasterchatError,
  MembersOnlyError,
  NoPermissionError,
  UnavailableError,
} from "./errors";
import { buildMeta } from "./modules/actions/parser";
import { ActionCatalog, ActionInfo } from "./modules/actions/types";
import { parseChatAction } from "./modules/chat/parser";
import {
  Action,
  AddChatItemAction,
  ChatResponse,
  FetchChatOptions,
  IterateChatOptions,
} from "./modules/chat/types";
import {
  getTimedContinuation,
  unwrapReplayActions,
} from "./modules/chat/utils";
import {
  parseMetadataFromEmbed,
  parseMetadataFromWatch,
} from "./modules/context/parser";
import { lrc, rmp, rtc, smp } from "./protobuf/assembler";
import {
  debugLog,
  delay,
  runsToString,
  toVideoId,
  withContext,
  ytFetch,
} from "./utils";
import { YTChatErrorStatus, YTLiveChatTextMessageRenderer } from "./yt";
import {
  YTAction,
  YTActionResponse,
  YTChatResponse,
  YTGetItemContextMenuResponse,
} from "./yt/chat";
export { Credentials } from "./auth";
export * from "./errors";
export * from "./modules/actions";
export * from "./modules/chat";
export * from "./modules/context";
export { StreamPool } from "./pool";
export * from "./protobuf";
export { delay, runsToString, toVideoId, endpointToUrl } from "./utils";
export * from "./yt";

export interface Metadata {
  videoId: string;
  channelId: string;
  channelName?: string;
  title?: string;
  isLive?: boolean;
}

export interface Events {
  data: (data: ChatResponse, mc: Masterchat) => void;
  actions: (actions: Action[], mc: Masterchat) => void;
  chats: (chats: AddChatItemAction[], mc: Masterchat) => void;
  end: () => void;
  error: (error: MasterchatError | Error) => void;
}

export type RetryOptions = {
  retry?: number;
  retryInterval?: number;
};

export type ChatListener = Promise<void>;

export interface Masterchat {
  on<U extends keyof Events>(event: U, listener: Events[U]): this;
  once<U extends keyof Events>(event: U, listener: Events[U]): this;
  addListener<U extends keyof Events>(event: U, listener: Events[U]): this;
  off<U extends keyof Events>(event: U, listener: Events[U]): this;
  removeListener<U extends keyof Events>(event: U, listener: Events[U]): this;
  emit<U extends keyof Events>(
    event: U,
    ...args: Parameters<Events[U]>
  ): boolean;
}

export interface MasterchatOptions {
  /** you can grab Credentials using `extra/credential-fetcher` */
  credentials?: Credentials | string;

  /** set live chat mode
   *
   * ```
   * if undefined,
   *   live -> OK
   *   archive -> OK
   *
   * if "live":
   *   live -> OK
   *   archive -> throw DisabledChatError
   *
   * if "replay":
   *   live -> throw DisabledChatError
   *   archive -> OK
   * ```
   */
  mode?: "live" | "replay";
}

// umbrella class
export class Masterchat extends EventEmitter {
  public isLive?: boolean;
  public videoId!: string;
  public channelId!: string;
  public channelName?: string;
  public title?: string;

  private credentials?: Credentials;
  private listener: ChatListener | null = null;
  private listenerAbortion: AbortController = new AbortController();

  /**
   * Useful when you don't know channelId or isLive status
   */
  static async init(videoIdOrUrl: string, options: MasterchatOptions = {}) {
    const videoId = toVideoId(videoIdOrUrl);
    if (!videoId) {
      throw new InvalidArgumentError(
        `Failed to extract video id: ${videoIdOrUrl}`
      );
    }
    // set channelId "" as populateMetadata will fill out it anyways
    const mc = new Masterchat(videoId, "", {
      ...options,
    });
    await mc.populateMetadata();
    return mc;
  }

  /**
   * Much faster than Masterchat.init
   */
  constructor(
    videoId: string,
    channelId: string,
    { mode, credentials }: MasterchatOptions = {}
  ) {
    super();
    this.videoId = videoId;
    this.channelId = channelId;
    this.isLive =
      mode === "live" ? true : mode === "replay" ? false : undefined;

    this.setCredentials(credentials);
  }

  get stopped() {
    return this.listener === null;
  }

  get metadata() {
    return {
      videoId: this.videoId,
      channelId: this.channelId,
      channelName: this.channelName,
      title: this.title,
      isLive: this.isLive,
    };
  }

  /**
   * Set credentials. This will take effect on the subsequent requests.
   */
  setCredentials(credentials?: Credentials | string): void {
    if (typeof credentials === "string") {
      credentials = JSON.parse(
        Buffer.from(credentials, "base64").toString()
      ) as Credentials;
    }

    this.credentials = credentials;
  }

  /**
   * Chat API
   */

  public listen(iterateOptions?: IterateChatOptions) {
    if (this.listener) return this.listener;

    this.listenerAbortion = new AbortController();

    const makePromise = async ({
      iterateOptions,
    }: {
      iterateOptions?: IterateChatOptions;
    }) => {
      // NOTE: `ignoreFirstResponse=false` means you might get chats already processed before when recovering MasterchatAgent from error. Make sure you have unique index for chat id to prevent duplication.
      for await (const res of this.iterate(iterateOptions)) {
        this.emit("data", res, this);

        const { actions } = res;
        this.emit("actions", actions, this);

        // only normal chats
        if (this.listenerCount("chats") > 0) {
          const chats = actions.filter(
            (action): action is AddChatItemAction =>
              action.type === "addChatItemAction"
          );
          this.emit("chats", chats, this);
        }
      }
    };

    this.listener = makePromise({
      iterateOptions,
    })
      .then(() => {
        // live chat closed by streamer
        this.emit("end");
      })
      .catch((err) => {
        if (err instanceof AbortError) return;
        this.emit("error", err);
      })
      .finally(() => {
        this.listener = null;
      });

    return this.listener;
  }

  public stop(): void {
    if (!this.listener) return;
    this.listenerAbortion.abort();
    this.emit("end");
  }

  async fetch(options?: FetchChatOptions): Promise<ChatResponse>;
  async fetch(token: string, options?: FetchChatOptions): Promise<ChatResponse>;
  async fetch(
    tokenOrOptions?: string | FetchChatOptions,
    maybeOptions?: FetchChatOptions
  ): Promise<ChatResponse> {
    const options =
      (typeof tokenOrOptions === "string" ? maybeOptions : tokenOrOptions) ??
      {};

    const topChat = options.topChat ?? false;
    const target = this.cvPair();
    let retryRemaining = 3;
    const retryInterval = 3000;
    let requestUrl: string = "";
    let requestBody;
    let response: YTChatResponse;

    function applyNewLiveStatus(isLive: boolean) {
      requestUrl = isLive ? constants.EP_GLC : constants.EP_GLCR;

      const continuation =
        typeof tokenOrOptions === "string"
          ? tokenOrOptions
          : isLive
          ? lrc(target, { top: topChat })
          : rtc(target, { top: topChat });

      requestBody = withContext({
        continuation,
      });
    }

    applyNewLiveStatus(this.isLive ?? true);

    loop: while (true) {
      try {
        const res = await this.post(requestUrl, requestBody);
        response = await res.json();

        if (response.error) {
          /** error.code ->
           * 400: request contains an invalid argument
           *   - when attempting to access livechat while it is already in replay mode
           * 403: no permission
           *   - video was made private by uploader
           *   - something went wrong (server-side)
           * 404: not found
           *   - removed by uploader
           * 500: internal error
           *   - server-side failure
           * 503: The service is currently unavailable
           *   - temporary server-side failure
           */

          const { status, message } = response.error;
          this.log(`fetch`, `Error: ${status}`);

          switch (status) {
            // stream went privated or deleted
            // TODO: should we break loop normally as if the stream ended or throw errors to tell users?
            case YTChatErrorStatus.PermissionDenied:
              retryRemaining = 0;
              throw new NoPermissionError(message);
            case YTChatErrorStatus.NotFound:
              retryRemaining = 0;
              throw new UnavailableError(message);

            // stream already turned to archive OR completely malformed token
            case YTChatErrorStatus.Invalid:
              retryRemaining = 0;
              throw new InvalidArgumentError(message);

            // it might be temporary issue so should retry immediately
            case YTChatErrorStatus.Unavailable:
            case YTChatErrorStatus.Internal:
              throw new Error(message);

            default:
              this.log(
                `<!>fetch`,
                `Unrecognized error code`,
                status,
                message,
                JSON.stringify(response)
              );
              throw new Error(message);
          }
        }
      } catch (err) {
        // handle fetch abortion
        if ((err as any).type === "aborted") {
          throw new AbortError();
        }

        if (retryRemaining > 0) {
          retryRemaining -= 1;
          this.log(
            `fetch`,
            `Retrying remaining=${retryRemaining} interval=${retryInterval} source=${
              (err as any).name
            }`
          );
          await delay(retryInterval);
          continue loop;
        }

        /**
         *
         * "invalid-json" (429)
         * "system" => ECONNRESET, ETIMEOUT, etc (Service outage)
         */
        this.log(
          `fetch`,
          `Unrecoverable Error:`,
          `${(err as any).message} (${(err as any).code ?? ""}|${
            (err as any).type ?? ""
          })`
        );

        throw err;
      }

      const { continuationContents } = response;

      if (!continuationContents) {
        /** there's several possibilities lied here:
         * 1. live chat is over (primary)
         * 2. turned into membership-only stream
         * 3. given video is neither a live stream nor an archived stream
         * 4. chat got disabled
         */
        const obj = Object.assign({}, response) as any;
        delete obj["responseContext"];

        if ("contents" in obj) {
          const reason = runsToString(obj.contents.messageRenderer.text.runs);
          if (/disabled/.test(reason)) {
            // {contents: "Chat is disabled for this live stream."} => pre-chat unavailable
            // or accessing replay chat with live chat token

            // retry with replay endpoint if isLive is unknown
            if (this.isLive === undefined) {
              this.log("fetch", "switched to replay endpoint");
              this.isLive = false;
              applyNewLiveStatus(false);
              continue loop;
            }

            throw new DisabledChatError(reason);
          } else if (/currently unavailable/.test(reason)) {
            // {contents: "Sorry, live chat is currently unavailable"} =>
            // - Turned into members-only stream
            // - No stream recordings
            throw new MembersOnlyError(reason);
          }
          this.log(`fetch`, `continuationNotFound(with contents)`, reason);
        } else if ("trackingParams" in obj) {
          // {trackingParams} => ?
          this.log(
            `fetch`,
            `<!>continuationNotFound(with trackingParams)`,
            JSON.stringify(obj)
          );
        }

        // {} => Live stream ended
        return {
          actions: [],
          continuation: undefined,
          error: null,
        };
      }

      const newContinuation = getTimedContinuation(continuationContents);

      let rawActions = continuationContents.liveChatContinuation.actions;

      // this means no chat available between the time window
      if (!rawActions) {
        return {
          actions: [],
          continuation: newContinuation,
          error: null,
        };
      }

      // unwrap replay actions into YTActions
      if (!(this.isLive ?? true)) {
        rawActions = unwrapReplayActions(rawActions);
      }

      const actions = rawActions
        .map(parseChatAction)
        .filter((a): a is Action => a !== undefined);

      const chat: ChatResponse = {
        actions,
        continuation: newContinuation,
        error: null,
      };

      return chat;
    }
  }

  /**
   * Iterate chat until live stream ends
   */
  async *iterate({
    topChat = false,
    ignoreFirstResponse = false,
    continuation,
  }: IterateChatOptions = {}): AsyncGenerator<ChatResponse> {
    const signal = this.listenerAbortion.signal;

    if (signal.aborted) {
      throw new AbortError();
    }

    let token: any = continuation ? continuation : { top: topChat };

    let treatedFirstResponse = false;

    // continuously fetch chat fragments
    while (true) {
      const res = await this.fetch(token);
      const startMs = Date.now();

      // handle chats
      if (!(ignoreFirstResponse && !treatedFirstResponse)) {
        yield res;
      }

      treatedFirstResponse = true;

      // refresh continuation token
      const { continuation } = res;

      if (!continuation) {
        this.log("iterate", "will break loop as missing continuation");
        break;
      }

      token = continuation.token;

      if (this.isLive ?? true) {
        const driftMs = Date.now() - startMs;
        // this.log("iterate", `driftMs: ${driftMs}`);
        const timeoutMs = continuation.timeoutMs - driftMs;
        if (timeoutMs > 0) {
          await delay(timeoutMs, signal);
        }
      }
    }
  }

  /**
   * Context API
   */

  async populateMetadata(): Promise<void> {
    const metadata = await this.fetchMetadataFromWatch(this.videoId);

    this.title = metadata.title;
    this.channelId = metadata.channelId;
    this.channelName = metadata.channelName;
    this.isLive = metadata.isLive;
  }

  async fetchMetadataFromWatch(id: string) {
    const res = await this.get("/watch?v=" + this.videoId);

    // Check ban status
    if (res.status === 429) {
      throw new AccessDeniedError("Rate limit exceeded: " + this.videoId);
    }

    const html = await res.text();
    return parseMetadataFromWatch(html);
  }

  async fetchMetadataFromEmbed(id: string) {
    const res = await this.get(`/embed/${id}`);

    if (res.status === 429)
      throw new AccessDeniedError("Rate limit exceeded: " + id);

    const html = await res.text();
    return parseMetadataFromEmbed(html);
  }

  /**
   * Message
   */

  async sendMessage(message: string): Promise<YTLiveChatTextMessageRenderer> {
    const params = smp(this.cvPair());

    const body = withContext({
      richMessage: {
        textSegments: [
          {
            text: message,
          },
        ],
      },
      params,
    });

    const res = await this.postWithRetry<YTActionResponse>(
      constants.EP_SM,
      body
    );

    const item = res.actions?.[0].addChatItemAction?.item;
    if (!(item && "liveChatTextMessageRenderer" in item)) {
      throw new Error(`Invalid response: ` + item);
    }
    return item.liveChatTextMessageRenderer;
  }

  /**
   * Context Menu Actions API
   */

  // async report(contextMenuEndpointParams: string) {
  //   const catalog = await this.getActionCatalog(contextMenuEndpointParams);
  //   const actionInfo = catalog?.report;
  //   if (!actionInfo) return;
  //   return await this.sendAction(actionInfo);
  // }

  // TODO: narrow down return type
  async pin(contextMenuEndpointParams: string) {
    const catalog = await this.getActionCatalog(contextMenuEndpointParams);
    const actionInfo = catalog?.pin;
    if (!actionInfo) return;
    return await this.sendAction(actionInfo);
  }

  // TODO: narrow down return type
  async unpin(contextMenuEndpointParams: string) {
    const catalog = await this.getActionCatalog(contextMenuEndpointParams);
    const actionInfo = catalog?.unpin;
    if (!actionInfo) return;
    return await this.sendAction(actionInfo);
  }

  async remove(chatId: string) {
    const params = rmp(chatId, this.cvPair());
    const res = await this.postWithRetry<YTActionResponse>(
      constants.EP_M,
      withContext({
        params,
      })
    );
    if (!res.success) {
      // {"error":{"code":501,"message":"Operation is not implemented, or supported, or enabled.","errors":[{"message":"Operation is not implemented, or supported, or enabled.","domain":"global","reason":"notImplemented"}],"status":"UNIMPLEMENTED"}}
      throw new Error(`Failed to perform action: ` + JSON.stringify(res));
    }
    return res.actions[0].markChatItemAsDeletedAction!;
  }

  // TODO: narrow down return type
  async timeout(contextMenuEndpointParams: string) {
    const catalog = await this.getActionCatalog(contextMenuEndpointParams);
    const actionInfo = catalog?.timeout;
    if (!actionInfo) return;
    return await this.sendAction(actionInfo);
  }

  // TODO: narrow down return type
  async block(contextMenuEndpointParams: string) {
    const catalog = await this.getActionCatalog(contextMenuEndpointParams);
    const actionInfo = catalog?.block;
    if (!actionInfo) return;
    return await this.sendAction(actionInfo);
  }

  // TODO: narrow down return type
  async unblock(contextMenuEndpointParams: string) {
    const catalog = await this.getActionCatalog(contextMenuEndpointParams);
    const actionInfo = catalog?.unblock;
    if (!actionInfo) return;
    return await this.sendAction(actionInfo);
  }

  // TODO: narrow down return type
  async hide(contextMenuEndpointParams: string) {
    const catalog = await this.getActionCatalog(contextMenuEndpointParams);
    const actionInfo = catalog?.hide;
    if (!actionInfo) return;
    return await this.sendAction(actionInfo);
  }

  // TODO: narrow down return type
  async unhide(contextMenuEndpointParams: string) {
    const catalog = await this.getActionCatalog(contextMenuEndpointParams);
    const actionInfo = catalog?.unhide;
    if (!actionInfo) return;
    return await this.sendAction(actionInfo);
  }

  // TODO: narrow down return type
  async addModerator(contextMenuEndpointParams: string) {
    const catalog = await this.getActionCatalog(contextMenuEndpointParams);
    const actionInfo = catalog?.addModerator;
    if (!actionInfo) return;
    return await this.sendAction(actionInfo);
  }

  // TODO: narrow down return type
  async removeModerator(contextMenuEndpointParams: string) {
    const catalog = await this.getActionCatalog(contextMenuEndpointParams);
    const actionInfo = catalog?.removeModerator;
    if (!actionInfo) return;
    return await this.sendAction(actionInfo);
  }

  private async sendAction<T = YTAction[]>(actionInfo: ActionInfo): Promise<T> {
    const url = actionInfo.url;
    let res;
    if (actionInfo.isPost) {
      res = await this.post(url, {
        body: JSON.stringify(
          withContext({
            params: actionInfo.params,
          })
        ),
      });
    } else {
      res = await this.get(url);
    }
    const json = await res.json();
    if (!json.success) {
      throw new Error(`Failed to perform action: ` + JSON.stringify(json));
    }
    return json.actions;
  }

  /**
   * NOTE: urlParams: pbj=1|0
   */
  private async getActionCatalog(
    contextMenuEndpointParams: string
  ): Promise<ActionCatalog | undefined> {
    const query = new URLSearchParams({
      params: contextMenuEndpointParams,
    });
    const endpoint = constants.EP_GICM + "&" + query.toString();
    const response = await this.postWithRetry<YTGetItemContextMenuResponse>(
      endpoint,
      withContext(),
      {
        retry: 2,
      }
    );

    if (response.error) {
      // TODO: handle this
      // {
      //   "error": {
      //     "code": 400,
      //     "message": "Precondition check failed.",
      //     "errors": [
      //       {
      //         "message": "Precondition check failed.",
      //         "domain": "global",
      //         "reason": "failedPrecondition"
      //       }
      //     ],
      //     "status": "FAILED_PRECONDITION"
      //   }
      // }
      return undefined;
    }

    let items: ActionCatalog = {};
    for (const item of response.liveChatItemContextMenuSupportedRenderers!
      .menuRenderer.items) {
      const rdr =
        item.menuServiceItemRenderer ?? item.menuNavigationItemRenderer!;
      const text = rdr.text.runs[0].text;

      switch (text) {
        case "Report": {
          const endpoint = item.menuServiceItemRenderer!.serviceEndpoint;
          items.report = buildMeta(endpoint);
          break;
        }
        case "Block": {
          const endpoint =
            item.menuNavigationItemRenderer!.navigationEndpoint
              .confirmDialogEndpoint!.content.confirmDialogRenderer
              .confirmButton.buttonRenderer.serviceEndpoint;
          items.block = buildMeta(endpoint);
          break;
        }
        case "Unblock": {
          const endpoint = item.menuServiceItemRenderer!.serviceEndpoint;
          items.unblock = buildMeta(endpoint);
          break;
        }
        case "Pin message": {
          const endpoint = item.menuServiceItemRenderer!.serviceEndpoint;
          items.pin = buildMeta(endpoint);
          break;
        }
        case "Unpin message": {
          const endpoint = item.menuServiceItemRenderer!.serviceEndpoint;
          items.unpin = buildMeta(endpoint);
          break;
        }
        case "Remove": {
          const endpoint = item.menuServiceItemRenderer!.serviceEndpoint;
          items.remove = buildMeta(endpoint);
          break;
        }
        case "Put user in timeout": {
          const endpoint = item.menuServiceItemRenderer!.serviceEndpoint;
          items.timeout = buildMeta(endpoint);
          break;
        }
        case "Hide user on this channel": {
          const endpoint = item.menuServiceItemRenderer!.serviceEndpoint;
          items.hide = buildMeta(endpoint);
          break;
        }
        case "Unhide user on this channel": {
          const endpoint = item.menuServiceItemRenderer!.serviceEndpoint;
          items.unhide = buildMeta(endpoint);
          break;
        }
        case "Add moderator": {
          const endpoint = item.menuServiceItemRenderer!.serviceEndpoint;
          items.addModerator = buildMeta(endpoint);
          break;
        }
        case "Remove moderator": {
          const endpoint = item.menuServiceItemRenderer!.serviceEndpoint;
          items.removeModerator = buildMeta(endpoint);
          break;
        }
      }
    }
    return items;
  }

  /**
   * Private API
   */

  private async postWithRetry<T>(
    input: string,
    body: any,
    options?: RetryOptions
  ): Promise<T> {
    const errors = [];

    let remaining = options?.retry ?? 0;
    const retryInterval = options?.retryInterval ?? 1000;

    while (true) {
      try {
        const res = await this.post(input, body);
        return await res.json();
      } catch (err) {
        if (err instanceof Error) {
          if (err.name === "AbortError") throw err;

          errors.push(err);

          if (remaining > 0) {
            await delay(retryInterval);
            remaining -= 1;
            debugLog(
              `Retrying(postJson) remaining=${remaining} after=${retryInterval}`
            );
            continue;
          }

          (err as any).errors = errors;
        }
        throw err;
      }
    }
  }

  private async post(input: string, body: any): Promise<Response> {
    const init = {
      signal: this.listenerAbortion.signal,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(this.credentials && buildAuthHeaders(this.credentials)),
      },
      body: JSON.stringify(body),
    };
    return ytFetch(input, init);
  }

  private get(input: string) {
    const init = {
      signal: this.listenerAbortion.signal,
      headers: {
        ...(this.credentials && buildAuthHeaders(this.credentials)),
      },
    };
    return ytFetch(input, init);
  }

  private log(label: string, ...obj: any) {
    debugLog(`${label}(${this.videoId}):`, ...obj);
  }

  private cvPair() {
    return {
      channelId: this.channelId,
      videoId: this.videoId,
    };
  }
}
