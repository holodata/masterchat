import { EventEmitter } from "events";
import {
  Action,
  AddChatItemAction,
  ChatResponse,
  Credentials,
  IterateChatOptions,
  Masterchat,
  MasterchatError,
  MasterchatOptions,
  Metadata,
} from ".";

type VideoId = string;

interface StreamPoolEvents {
  data: (data: ChatResponse, metadata: Metadata) => void;
  actions: (actions: Action[], metadata: Metadata) => void;
  chats: (chats: AddChatItemAction[], metadata: Metadata) => void;
  end: (metadata: Metadata) => void;
  error: (error: MasterchatError | Error, metadata: Metadata) => void;
}

export interface StreamPool {
  on<U extends keyof StreamPoolEvents>(
    event: U,
    listener: StreamPoolEvents[U]
  ): this;
  addListener<U extends keyof StreamPoolEvents>(
    event: U,
    listener: StreamPoolEvents[U]
  ): this;
  off<U extends keyof StreamPoolEvents>(
    event: U,
    listener: StreamPoolEvents[U]
  ): this;
  removeListener<U extends keyof StreamPoolEvents>(
    event: U,
    listener: StreamPoolEvents[U]
  ): this;
  emit<U extends keyof StreamPoolEvents>(
    event: U,
    ...args: Parameters<StreamPoolEvents[U]>
  ): boolean;
}

export class StreamPool extends EventEmitter {
  private pool: Map<VideoId, Masterchat> = new Map();
  private options?: MasterchatOptions;
  private started: boolean = false;

  constructor(options?: MasterchatOptions) {
    super();
    this.options = options;
    this.ensure();
  }

  public get entries() {
    return Array.from(this.pool.entries());
  }

  public async forEach(
    fn: (agent: Masterchat, videoId: string, index: number) => void
  ) {
    return Promise.allSettled(
      this.entries.map(([videoId, instance], i) =>
        Promise.resolve(fn(instance, videoId, i))
      )
    );
  }

  public setCredentials(credentials?: Credentials | string) {
    this.forEach((instance) => {
      instance.setCredentials(credentials);
    });
  }

  public get(videoId: string) {
    return this.pool.get(videoId);
  }

  /**
   * resolves after every stream closed
   */
  private ensure() {
    return new Promise<void>((resolve) => {
      const timer = setInterval(() => {
        if (this.streamCount() === 0) {
          clearInterval(timer);
          resolve();
        }
      }, 1000);
    });
  }

  /**
   * number of active streams
   */
  streamCount() {
    return this.pool.size;
  }

  /**
   * check if the given stream is already subscribed
   */
  has(videoId: string) {
    return this.pool.has(videoId);
  }

  /**
   * subscribe live chat.
   * always guarantees single instance for each stream.
   */
  subscribe(
    videoId: string,
    channelId: string,
    iterateOptions?: IterateChatOptions
  ): Masterchat {
    if (this.has(videoId)) return this.pool.get(videoId)!;

    const mc = new Masterchat(videoId, channelId, this.options);

    mc.on("end", () => this._handleEnd(mc));
    mc.on("error", (err) => this._handleError(mc, err));
    mc.on("data", (data) => {
      this._handleData(mc, data);
    });
    mc.on("actions", (actions) => {
      this._handleActions(mc, actions);
    });
    mc.on("chats", (chats) => {
      this._handleChats(mc, chats);
    });
    mc.listen(iterateOptions);

    if (!this.started) {
      this.started = true;
      this.ensure();
    }

    this.pool.set(videoId, mc);

    return mc;
  }

  /**
   * stop subscribing live chat
   */
  unsubscribe(videoId: string) {
    const mc = this.pool.get(videoId);
    if (!mc) return;
    mc.stop(); // will emit 'end' event
  }

  private _handleData(mc: Masterchat, data: ChatResponse) {
    this.emit("data", data, mc.metadata);
  }

  private _handleActions(mc: Masterchat, actions: Action[]) {
    this.emit("actions", actions, mc.metadata);
  }

  private _handleChats(mc: Masterchat, chats: AddChatItemAction[]) {
    this.emit("chats", chats, mc.metadata);
  }

  private _handleEnd(mc: Masterchat) {
    this.pool.delete(mc.videoId);
    this.emit("end", mc.metadata);
  }

  private _handleError(mc: Masterchat, err: MasterchatError | Error) {
    this.pool.delete(mc.videoId);
    this.emit("error", err, mc.metadata);
  }
}
