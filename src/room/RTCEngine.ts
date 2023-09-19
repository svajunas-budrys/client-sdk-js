import { EventEmitter } from 'events';
import type { MediaAttributes } from 'sdp-transform';
import type TypedEventEmitter from 'typed-emitter';
import type { SignalOptions } from '../api/SignalClient';
import { SignalClient } from '../api/SignalClient';
import log from '../logger';
import type { InternalRoomOptions } from '../options';
import {
  ClientConfigSetting,
  ClientConfiguration,
  DataPacket,
  DataPacket_Kind,
  DisconnectReason,
  ParticipantInfo,
  ReconnectReason,
  Room as RoomModel,
  SpeakerInfo,
  TrackInfo,
  UserPacket,
} from '../proto/livekit_models_pb';
import type {
  AddTrackRequest,
  ConnectionQualityUpdate,
  JoinResponse,
  LeaveRequest,
  ReconnectResponse,
  StreamStateUpdate,
  SubscriptionPermissionUpdate,
  SubscriptionResponse,
  TrackPublishedResponse,
} from '../proto/livekit_rtc_pb';
import PCTransport, { PCEvents } from './PCTransport';
import type { ReconnectContext, ReconnectPolicy } from './ReconnectPolicy';
import type { RegionUrlProvider } from './RegionUrlProvider';
import { TransportManager } from './TransportManager';
import { roomConnectOptionDefaults } from './defaults';
import {
  ConnectionError,
  ConnectionErrorReason,
  NegotiationError,
  TrackInvalidError,
  UnexpectedConnectionState,
} from './errors';
import { EngineEvent } from './events';
import CriticalTimers from './timers';
import type LocalTrack from './track/LocalTrack';
import type LocalVideoTrack from './track/LocalVideoTrack';
import type { SimulcastTrackInfo } from './track/LocalVideoTrack';
import type { Track } from './track/Track';
import type { TrackPublishOptions, VideoCodec } from './track/options';
import { Mutex, isVideoCodec, isWeb } from './utils';

const leaveReconnect = 'leave-reconnect';

enum PCState {
  New,
  Connected,
  Disconnected,
  Reconnecting,
  Closed,
}

/** @internal */
export default class RTCEngine extends (EventEmitter as new () => TypedEventEmitter<EngineEventCallbacks>) {
  client: SignalClient;

  rtcConfig: RTCConfiguration = {};

  peerConnectionTimeout: number = roomConnectOptionDefaults.peerConnectionTimeout;

  fullReconnectOnNext: boolean = false;

  transportManager?: TransportManager;

  /**
   * @internal
   */
  latestJoinResponse?: JoinResponse;

  get isClosed() {
    return this._isClosed;
  }

  private lossyDC?: RTCDataChannel;

  // @ts-ignore noUnusedLocals
  private lossyDCSub?: RTCDataChannel;

  private reliableDC?: RTCDataChannel;

  private dcBufferStatus: Map<DataPacket_Kind, boolean>;

  // @ts-ignore noUnusedLocals
  private reliableDCSub?: RTCDataChannel;

  private subscriberPrimary: boolean = false;

  private primaryPC?: RTCPeerConnection;

  private pcState: PCState = PCState.New;

  private _isClosed: boolean = true;

  private pendingTrackResolvers: {
    [key: string]: { resolve: (info: TrackInfo) => void; reject: () => void };
  } = {};

  // true if publisher connection has already been established.
  // this is helpful to know if we need to restart ICE on the publisher connection
  private hasPublished: boolean = false;

  // keep join info around for reconnect, this could be a region url
  private url?: string;

  private token?: string;

  private signalOpts?: SignalOptions;

  private reconnectAttempts: number = 0;

  private reconnectStart: number = 0;

  private clientConfiguration?: ClientConfiguration;

  private attemptingReconnect: boolean = false;

  private reconnectPolicy: ReconnectPolicy;

  private reconnectTimeout?: ReturnType<typeof setTimeout>;

  private participantSid?: string;

  /** keeps track of how often an initial join connection has been tried */
  private joinAttempts: number = 0;

  /** specifies how often an initial join connection is allowed to retry */
  private maxJoinAttempts: number = 1;

  private closingLock: Mutex;

  private dataProcessLock: Mutex;

  private shouldFailNext: boolean = false;

  private regionUrlProvider?: RegionUrlProvider;

  constructor(private options: InternalRoomOptions) {
    super();
    this.client = new SignalClient();
    this.client.signalLatency = this.options.expSignalLatency;
    this.reconnectPolicy = this.options.reconnectPolicy;
    this.registerOnLineListener();
    this.closingLock = new Mutex();
    this.dataProcessLock = new Mutex();
    this.dcBufferStatus = new Map([
      [DataPacket_Kind.LOSSY, true],
      [DataPacket_Kind.RELIABLE, true],
    ]);

    this.client.onParticipantUpdate = (updates) =>
      this.emit(EngineEvent.ParticipantUpdate, updates);
    this.client.onConnectionQuality = (update) =>
      this.emit(EngineEvent.ConnectionQualityUpdate, update);
    this.client.onRoomUpdate = (update) => this.emit(EngineEvent.RoomUpdate, update);
    this.client.onSubscriptionError = (resp) => this.emit(EngineEvent.SubscriptionError, resp);
    this.client.onSubscriptionPermissionUpdate = (update) =>
      this.emit(EngineEvent.SubscriptionPermissionUpdate, update);
    this.client.onSpeakersChanged = (update) => this.emit(EngineEvent.SpeakersChanged, update);
    this.client.onStreamStateUpdate = (update) => this.emit(EngineEvent.StreamStateChanged, update);
  }

  async join(
    url: string,
    token: string,
    opts: SignalOptions,
    abortSignal?: AbortSignal,
  ): Promise<JoinResponse> {
    this.url = url;
    this.token = token;
    this.signalOpts = opts;
    this.maxJoinAttempts = opts.maxRetries;
    try {
      this.joinAttempts += 1;

      this.setupSignalClientCallbacks();
      const joinResponse = await this.client.join(url, token, opts, abortSignal);
      this._isClosed = false;
      this.latestJoinResponse = joinResponse;

      this.subscriberPrimary = joinResponse.subscriberPrimary;
      if (!this.publisher) {
        this.configure(joinResponse);
      }

      // create offer
      if (!this.subscriberPrimary) {
        this.negotiate();
      }

      this.clientConfiguration = joinResponse.clientConfiguration;
      return joinResponse;
    } catch (e) {
      if (e instanceof ConnectionError) {
        if (e.reason === ConnectionErrorReason.ServerUnreachable) {
          log.warn(
            `Couldn't connect to server, attempt ${this.joinAttempts} of ${this.maxJoinAttempts}`,
          );
          if (this.joinAttempts < this.maxJoinAttempts) {
            return this.join(url, token, opts, abortSignal);
          }
        }
      }
      throw e;
    }
  }

  async close() {
    const unlock = await this.closingLock.lock();
    if (this.isClosed) {
      unlock();
      return;
    }
    try {
      this._isClosed = true;
      this.emit(EngineEvent.Closing);
      this.removeAllListeners();
      this.deregisterOnLineListener();
      this.clearPendingReconnect();
      await this.transportManager?.cleanupPeerConnections();
      await this.cleanupClient();
    } finally {
      unlock();
    }
  }

  async cleanupClient() {
    await this.client.close();
    this.client.resetCallbacks();
  }

  addTrack(req: AddTrackRequest): Promise<TrackInfo> {
    if (this.pendingTrackResolvers[req.cid]) {
      throw new TrackInvalidError('a track with the same ID has already been published');
    }
    return new Promise<TrackInfo>((resolve, reject) => {
      const publicationTimeout = setTimeout(() => {
        delete this.pendingTrackResolvers[req.cid];
        reject(
          new ConnectionError('publication of local track timed out, no response from server'),
        );
      }, 10_000);
      this.pendingTrackResolvers[req.cid] = {
        resolve: (info: TrackInfo) => {
          clearTimeout(publicationTimeout);
          resolve(info);
        },
        reject: () => {
          clearTimeout(publicationTimeout);
          reject(new Error('Cancelled publication by calling unpublish'));
        },
      };
      this.client.sendAddTrack(req);
    });
  }

  /**
   * Removes sender from PeerConnection, returning true if it was removed successfully
   * and a negotiation is necessary
   * @param sender
   * @returns
   */
  removeTrack(sender: RTCRtpSender): boolean {
    if (sender.track && this.pendingTrackResolvers[sender.track.id]) {
      const { reject } = this.pendingTrackResolvers[sender.track.id];
      if (reject) {
        reject();
      }
      delete this.pendingTrackResolvers[sender.track.id];
    }
    try {
      this.transportManager?.removeTrack(sender);
      return true;
    } catch (e: unknown) {
      log.warn('failed to remove track', { error: e, method: 'removeTrack' });
    }
    return false;
  }

  updateMuteStatus(trackSid: string, muted: boolean) {
    this.client.sendMuteTrack(trackSid, muted);
  }

  get dataSubscriberReadyState(): string | undefined {
    return this.reliableDCSub?.readyState;
  }

  async getConnectedServerAddress(): Promise<string | undefined> {
    if (this.primaryPC === undefined) {
      return undefined;
    }
    return getConnectedAddress(this.primaryPC);
  }

  /* @internal */
  setRegionUrlProvider(provider: RegionUrlProvider) {
    this.regionUrlProvider = provider;
  }

  private configure(joinResponse: JoinResponse) {
    // already configured
    if (this.transportManager) {
      return;
    }

    this.participantSid = joinResponse.participant?.sid;

    const rtcConfig = this.makeRTCConfiguration(joinResponse);

    if (this.signalOpts?.e2eeEnabled) {
      log.debug('E2EE - setting up transports with insertable streams');
      //  this makes sure that no data is sent before the transforms are ready
      // @ts-ignore
      rtcConfig.encodedInsertableStreams = true;
    }

    this.transportManager = new TransportManager(
      rtcConfig,
      joinResponse.subscriberPrimary,
      this.peerConnectionTimeout,
    );

    this.emit(
      EngineEvent.TransportsCreated,
      this.transportManager.publisher,
      this.transportManager.subscriber,
    );

    this.transportManager.onICECandidate = (candidate, target) =>
      this.client.sendIceCandidate(candidate, target);
    this.transportManager.onPublisherOffer = (offer) => this.client.sendOffer(offer);

    primaryPC.onconnectionstatechange = async () => {
      log.debug(`primary PC state changed ${primaryPC.connectionState}`);
      if (primaryPC.connectionState === 'connected') {
        const shouldEmit = this.pcState === PCState.New;
        this.pcState = PCState.Connected;
        if (shouldEmit) {
          this.emit(EngineEvent.Connected, joinResponse);
        }
      } else if (primaryPC.connectionState === 'failed') {
        // on Safari, PeerConnection will switch to 'disconnected' during renegotiation
        if (this.pcState === PCState.Connected) {
          this.pcState = PCState.Disconnected;

          this.handleDisconnect(
            'primary peerconnection',
            subscriberPrimary
              ? ReconnectReason.RR_SUBSCRIBER_FAILED
              : ReconnectReason.RR_PUBLISHER_FAILED,
          );
        }
      }
    };
    secondaryPC.onconnectionstatechange = async () => {
      log.debug(`secondary PC state changed ${secondaryPC.connectionState}`);
      // also reconnect if secondary peerconnection fails
      if (secondaryPC.connectionState === 'failed') {
        this.handleDisconnect(
          'secondary peerconnection',
          subscriberPrimary
            ? ReconnectReason.RR_PUBLISHER_FAILED
            : ReconnectReason.RR_SUBSCRIBER_FAILED,
        );
      }
    };

    this.transportManager.onRemoteTrack = (ev: RTCTrackEvent) => {
      this.emit(EngineEvent.MediaTrackAdded, ev.track, ev.streams[0], ev.receiver);
    };

    this.transportManager.onDataMessage = this.handleDataMessage;
  }

  private setupSignalClientCallbacks() {
    // configure signaling client
    this.client.onAnswer = async (sd) => {
      await this.transportManager?.setAnswer(sd);
    };

    // add candidate on trickle
    this.client.onTrickle = (candidate, target) => {
      if (!this.transportManager) {
        return;
      }
      log.trace('got ICE candidate from peer', { candidate, target });
      this.transportManager.addICECandidate(candidate, target);
    };

    // when server creates an offer for the client
    this.client.onOffer = async (sd) => {
      if (!this.transportManager) {
        return;
      }
      const answer = await this.transportManager.setOffer(sd);
      await this.client.sendAnswer(answer);
    };

    this.client.onLocalTrackPublished = (res: TrackPublishedResponse) => {
      log.debug('received trackPublishedResponse', res);
      if (!this.pendingTrackResolvers[res.cid]) {
        log.error(`missing track resolver for ${res.cid}`);
        return;
      }
      const { resolve } = this.pendingTrackResolvers[res.cid];
      delete this.pendingTrackResolvers[res.cid];
      resolve(res.track!);
    };

    this.client.onTokenRefresh = (token: string) => {
      this.token = token;
    };

    this.client.onClose = () => {
      this.handleDisconnect('signal', ReconnectReason.RR_SIGNAL_DISCONNECTED);
    };

    this.client.onLeave = (leave?: LeaveRequest) => {
      if (leave?.canReconnect) {
        this.fullReconnectOnNext = true;
        this.primaryPC = undefined;
        // reconnect immediately instead of waiting for next attempt
        this.handleDisconnect(leaveReconnect);
      } else {
        this.emit(EngineEvent.Disconnected, leave?.reason);
        this.close();
      }
      log.trace('leave request', { leave });
    };
  }

  private makeRTCConfiguration(serverResponse: JoinResponse | ReconnectResponse): RTCConfiguration {
    const rtcConfig = { ...this.rtcConfig };

    // update ICE servers before creating PeerConnection
    if (serverResponse.iceServers && !rtcConfig.iceServers) {
      const rtcIceServers: RTCIceServer[] = [];
      serverResponse.iceServers.forEach((iceServer) => {
        const rtcIceServer: RTCIceServer = {
          urls: iceServer.urls,
        };
        if (iceServer.username) rtcIceServer.username = iceServer.username;
        if (iceServer.credential) {
          rtcIceServer.credential = iceServer.credential;
        }
        rtcIceServers.push(rtcIceServer);
      });
      rtcConfig.iceServers = rtcIceServers;
    }

    if (
      serverResponse.clientConfiguration &&
      serverResponse.clientConfiguration.forceRelay === ClientConfigSetting.ENABLED
    ) {
      rtcConfig.iceTransportPolicy = 'relay';
    }

    // @ts-ignore
    rtcConfig.sdpSemantics = 'unified-plan';
    // @ts-ignore
    rtcConfig.continualGatheringPolicy = 'gather_continually';

    return rtcConfig;
  }

  private handleDataMessage = async (message: MessageEvent) => {
    // make sure to respect incoming data message order by processing message events one after the other
    const unlock = await this.dataProcessLock.lock();
    try {
      // decode
      let buffer: ArrayBuffer | undefined;
      if (message.data instanceof ArrayBuffer) {
        buffer = message.data;
      } else if (message.data instanceof Blob) {
        buffer = await message.data.arrayBuffer();
      } else {
        log.error('unsupported data type', message.data);
        return;
      }
      const dp = DataPacket.fromBinary(new Uint8Array(buffer));
      if (dp.value?.case === 'speaker') {
        // dispatch speaker updates
        this.emit(EngineEvent.ActiveSpeakersUpdate, dp.value.value.speakers);
      } else if (dp.value?.case === 'user') {
        this.emit(EngineEvent.DataPacketReceived, dp.value.value, dp.kind);
      }
    } finally {
      unlock();
    }
  };

  async createSender(
    track: LocalTrack,
    opts: TrackPublishOptions,
    encodings?: RTCRtpEncodingParameters[],
  ) {
    if (this.transportManager) {
      return this.transportManager.createSender(track, opts, encodings);
    }
    throw new UnexpectedConnectionState('No transport manager configured');
  }

  async createSimulcastSender(
    track: LocalVideoTrack,
    simulcastTrack: SimulcastTrackInfo,
    opts: TrackPublishOptions,
    encodings?: RTCRtpEncodingParameters[],
  ) {
    if (this.transportManager) {
      return this.transportManager.createSimulcastSender(track, simulcastTrack, opts, encodings);
    }
    throw new UnexpectedConnectionState('No transport manager configured');
  }

  // websocket reconnect behavior. if websocket is interrupted, and the PeerConnection
  // continues to work, we can reconnect to websocket to continue the session
  // after a number of retries, we'll close and give up permanently
  private handleDisconnect = (connection: string, disconnectReason?: ReconnectReason) => {
    if (this._isClosed) {
      return;
    }

    log.warn(`${connection} disconnected`);
    if (this.reconnectAttempts === 0) {
      // only reset start time on the first try
      this.reconnectStart = Date.now();
    }

    const disconnect = (duration: number) => {
      log.warn(
        `could not recover connection after ${this.reconnectAttempts} attempts, ${duration}ms. giving up`,
      );
      this.emit(EngineEvent.Disconnected);
      this.close();
    };

    const duration = Date.now() - this.reconnectStart;
    let delay = this.getNextRetryDelay({
      elapsedMs: duration,
      retryCount: this.reconnectAttempts,
    });

    if (delay === null) {
      disconnect(duration);
      return;
    }
    if (connection === leaveReconnect) {
      delay = 0;
    }

    log.debug(`reconnecting in ${delay}ms`);

    this.clearReconnectTimeout();
    if (this.token && this.regionUrlProvider) {
      // token may have been refreshed, we do not want to recreate the regionUrlProvider
      // since the current engine may have inherited a regional url
      this.regionUrlProvider.updateToken(this.token);
    }
    this.reconnectTimeout = CriticalTimers.setTimeout(
      () => this.attemptReconnect(disconnectReason),
      delay,
    );
  };

  private async attemptReconnect(reason?: ReconnectReason) {
    if (this._isClosed) {
      return;
    }
    // guard for attempting reconnection multiple times while one attempt is still not finished
    if (this.attemptingReconnect) {
      return;
    }
    if (
      this.clientConfiguration?.resumeConnection === ClientConfigSetting.DISABLED ||
      // signaling state could change to closed due to hardware sleep
      // those connections cannot be resumed
      (this.primaryPC?.signalingState ?? 'closed') === 'closed'
    ) {
      this.fullReconnectOnNext = true;
    }

    try {
      this.attemptingReconnect = true;
      if (this.fullReconnectOnNext) {
        await this.restartConnection();
      } else {
        await this.resumeConnection(reason);
      }
      this.clearPendingReconnect();
      this.fullReconnectOnNext = false;
    } catch (e) {
      this.reconnectAttempts += 1;
      let recoverable = true;
      if (e instanceof UnexpectedConnectionState) {
        log.debug('received unrecoverable error', { error: e });
        // unrecoverable
        recoverable = false;
      } else if (!(e instanceof SignalReconnectError)) {
        // cannot resume
        this.fullReconnectOnNext = true;
      }

      if (recoverable) {
        this.handleDisconnect('reconnect', ReconnectReason.RR_UNKNOWN);
      } else {
        log.info(
          `could not recover connection after ${this.reconnectAttempts} attempts, ${
            Date.now() - this.reconnectStart
          }ms. giving up`,
        );
        this.emit(EngineEvent.Disconnected);
        await this.close();
      }
    } finally {
      this.attemptingReconnect = false;
    }
  }

  private getNextRetryDelay(context: ReconnectContext) {
    try {
      return this.reconnectPolicy.nextRetryDelayInMs(context);
    } catch (e) {
      log.warn('encountered error in reconnect policy', { error: e });
    }

    // error in user code with provided reconnect policy, stop reconnecting
    return null;
  }

  private async restartConnection(regionUrl?: string) {
    try {
      if (!this.url || !this.token) {
        // permanent failure, don't attempt reconnection
        throw new UnexpectedConnectionState('could not reconnect, url or token not saved');
      }

      log.info(`reconnecting, attempt: ${this.reconnectAttempts}`);
      this.emit(EngineEvent.Restarting);

      if (this.client.isConnected) {
        await this.client.sendLeave();
      }
      await this.transportManager?.cleanupPeerConnections();
      await this.cleanupClient();

      let joinResponse: JoinResponse;
      try {
        if (!this.signalOpts) {
          log.warn('attempted connection restart, without signal options present');
          throw new SignalReconnectError();
        }
        // in case a regionUrl is passed, the region URL takes precedence
        joinResponse = await this.join(regionUrl ?? this.url, this.token, this.signalOpts);
      } catch (e) {
        if (e instanceof ConnectionError && e.reason === ConnectionErrorReason.NotAllowed) {
          throw new UnexpectedConnectionState('could not reconnect, token might be expired');
        }
        throw new SignalReconnectError();
      }

      if (this.shouldFailNext) {
        this.shouldFailNext = false;
        throw new Error('simulated failure');
      }

      this.client.setReconnected();
      this.emit(EngineEvent.SignalRestarted, joinResponse);

      await this.transportManager?.waitForPCReconnected();
      this.regionUrlProvider?.resetAttempts();
      // reconnect success
      this.emit(EngineEvent.Restarted);
    } catch (error) {
      const nextRegionUrl = await this.regionUrlProvider?.getNextBestRegionUrl();
      if (nextRegionUrl) {
        await this.restartConnection(nextRegionUrl);
        return;
      } else {
        // no more regions to try (or we're not on cloud)
        this.regionUrlProvider?.resetAttempts();
        throw error;
      }
    }
  }

  private async resumeConnection(reason?: ReconnectReason): Promise<void> {
    if (!this.url || !this.token) {
      // permanent failure, don't attempt reconnection
      throw new UnexpectedConnectionState('could not reconnect, url or token not saved');
    }
    // trigger publisher reconnect
    if (!this.transportManager) {
      throw new UnexpectedConnectionState('publisher and subscriber connections unset');
    }

    log.info(`resuming signal connection, attempt ${this.reconnectAttempts}`);
    this.emit(EngineEvent.Resuming);

    try {
      this.setupSignalClientCallbacks();
      const res = await this.client.reconnect(this.url, this.token, this.participantSid, reason);
      if (res) {
        const rtcConfig = this.makeRTCConfiguration(res);
        this.transportManager.setConfiguration(rtcConfig);
      }
    } catch (e) {
      let message = '';
      if (e instanceof Error) {
        message = e.message;
      }
      if (e instanceof ConnectionError && e.reason === ConnectionErrorReason.NotAllowed) {
        throw new UnexpectedConnectionState('could not reconnect, token might be expired');
      }
      throw new SignalReconnectError(message);
    }
    this.emit(EngineEvent.SignalResumed);

    if (this.shouldFailNext) {
      this.shouldFailNext = false;
      throw new Error('simulated failure');
    }

    await this.transportManager.resumeTransports();

    this.client.setReconnected();

    // recreate publish datachannel if it's id is null
    // (for safari https://bugs.webkit.org/show_bug.cgi?id=184688)
    if (this.reliableDC?.readyState === 'open' && this.reliableDC.id === null) {
      this.transportManager?.createDataChannels();
    }

    // resume success
    this.emit(EngineEvent.Resumed);
  }

  async waitForPCInitialConnection(timeout?: number, abortController?: AbortController) {
    if (this.pcState === PCState.Connected) {
      return;
    }
    if (this.pcState !== PCState.New) {
      throw new UnexpectedConnectionState(
        'Expected peer connection to be new on initial connection',
      );
    }
    return new Promise<void>((resolve, reject) => {
      const abortHandler = () => {
        log.warn('closing engine');
        CriticalTimers.clearTimeout(connectTimeout);

        reject(
          new ConnectionError(
            'room connection has been cancelled',
            ConnectionErrorReason.Cancelled,
          ),
        );
      };
      if (abortController?.signal.aborted) {
        abortHandler();
      }
      abortController?.signal.addEventListener('abort', abortHandler);
      const onConnected = () => {
        CriticalTimers.clearTimeout(connectTimeout);
        abortController?.signal.removeEventListener('abort', abortHandler);
        resolve();
      };
      const connectTimeout = CriticalTimers.setTimeout(() => {
        this.off(EngineEvent.Connected, onConnected);
        reject(new ConnectionError('could not establish pc connection'));
      }, timeout ?? this.peerConnectionTimeout);
      this.once(EngineEvent.Connected, onConnected);
    });
  }

  waitForRestarted = () => {
    return new Promise<void>((resolve, reject) => {
      if (this.pcState === PCState.Connected) {
        resolve();
      }
      const onRestarted = () => {
        this.off(EngineEvent.Disconnected, onDisconnected);
        resolve();
      };
      const onDisconnected = () => {
        this.off(EngineEvent.Restarted, onRestarted);
        reject();
      };
      this.once(EngineEvent.Restarted, onRestarted);
      this.once(EngineEvent.Disconnected, onDisconnected);
    });
  };

  /* @internal */
  async sendDataPacket(packet: DataPacket, kind: DataPacket_Kind) {
    const msg = packet.toBinary();

    // make sure we do have a data connection
    await this.ensurePublisherConnected(kind);

    const dc = this.transportManager?.getDataChannelForKind(kind);
    if (dc) {
      dc.send(msg);
    }

    this.updateAndEmitDCBufferStatus(kind);
  }

  private updateAndEmitDCBufferStatus = (kind: DataPacket_Kind) => {
    const status = this.isBufferStatusLow(kind);
    if (typeof status !== 'undefined' && status !== this.dcBufferStatus.get(kind)) {
      this.dcBufferStatus.set(kind, status);
      this.emit(EngineEvent.DCBufferStatusChanged, status, kind);
    }
  };

  private isBufferStatusLow = (kind: DataPacket_Kind): boolean | undefined => {
    const dc = this.transportManager?.getDataChannelForKind(kind);
    if (dc) {
      return dc.bufferedAmount <= dc.bufferedAmountLowThreshold;
    }
  };

  private async ensurePublisherConnected(kind: DataPacket_Kind) {
    await this.ensureDataTransportConnected(kind, false);
  }

  /* @internal */
  verifyTransport(): boolean {
    if (!this.transportManager) {
      return false;
    }
    this.transportManager.verifyTransport();
    // ensure signal is connected
    if (!this.client.ws || this.client.ws.readyState === WebSocket.CLOSED) {
      return false;
    }
    return true;
  }

  /** @internal */
  negotiate(): Promise<void> {
    // observe signal state
    return new Promise<void>((resolve, reject) => {
      if (!this.publisher) {
        reject(new NegotiationError('publisher is not defined'));
        return;
      }

      this.hasPublished = true;

      const handleClosed = () => {
        log.debug('engine disconnected while negotiation was ongoing');
        cleanup();
        resolve();
        return;
      };

      if (this.isClosed) {
        reject('cannot negotiate on closed engine');
      }
      this.on(EngineEvent.Closing, handleClosed);

      const negotiationTimeout = setTimeout(() => {
        reject('negotiation timed out');
        this.handleDisconnect('negotiation', ReconnectReason.RR_SIGNAL_DISCONNECTED);
      }, this.peerConnectionTimeout);

      const cleanup = () => {
        clearTimeout(negotiationTimeout);
        this.off(EngineEvent.Closing, handleClosed);
      };

      this.publisher.once(PCEvents.NegotiationStarted, () => {
        this.publisher?.once(PCEvents.NegotiationComplete, () => {
          cleanup();
          resolve();
        });
      });

      this.publisher.once(PCEvents.RTPVideoPayloadTypes, (rtpTypes: MediaAttributes['rtp']) => {
        const rtpMap = new Map<number, VideoCodec>();
        rtpTypes.forEach((rtp) => {
          const codec = rtp.codec.toLowerCase();
          if (isVideoCodec(codec)) {
            rtpMap.set(rtp.payload, codec);
          }
        });
        this.emit(EngineEvent.RTPVideoMapUpdate, rtpMap);
      });

      this.publisher.negotiate((e) => {
        cleanup();
        reject(e);
        if (e instanceof NegotiationError) {
          this.fullReconnectOnNext = true;
        }
        this.handleDisconnect('negotiation', ReconnectReason.RR_UNKNOWN);
      });
    });
  }

  /* @internal */
  failNext() {
    // debugging method to fail the next reconnect/resume attempt
    this.shouldFailNext = true;
  }

  private clearReconnectTimeout() {
    if (this.reconnectTimeout) {
      CriticalTimers.clearTimeout(this.reconnectTimeout);
    }
  }

  private clearPendingReconnect() {
    this.clearReconnectTimeout();
    this.reconnectAttempts = 0;
  }

  private handleBrowserOnLine = () => {
    // in case the engine is currently reconnecting, attempt a reconnect immediately after the browser state has changed to 'onLine'
    if (this.client.isReconnecting) {
      this.clearReconnectTimeout();
      this.attemptReconnect(ReconnectReason.RR_SIGNAL_DISCONNECTED);
    }
  };

  private registerOnLineListener() {
    if (isWeb()) {
      window.addEventListener('online', this.handleBrowserOnLine);
    }
  }

  private deregisterOnLineListener() {
    if (isWeb()) {
      window.removeEventListener('online', this.handleBrowserOnLine);
    }
  }
}

async function getConnectedAddress(pc: RTCPeerConnection): Promise<string | undefined> {
  let selectedCandidatePairId = '';
  const candidatePairs = new Map<string, RTCIceCandidatePairStats>();
  // id -> candidate ip
  const candidates = new Map<string, string>();
  const stats: RTCStatsReport = await pc.getStats();
  stats.forEach((v) => {
    switch (v.type) {
      case 'transport':
        selectedCandidatePairId = v.selectedCandidatePairId;
        break;
      case 'candidate-pair':
        if (selectedCandidatePairId === '' && v.selected) {
          selectedCandidatePairId = v.id;
        }
        candidatePairs.set(v.id, v);
        break;
      case 'remote-candidate':
        candidates.set(v.id, `${v.address}:${v.port}`);
        break;
      default:
    }
  });

  if (selectedCandidatePairId === '') {
    return undefined;
  }
  const selectedID = candidatePairs.get(selectedCandidatePairId)?.remoteCandidateId;
  if (selectedID === undefined) {
    return undefined;
  }
  return candidates.get(selectedID);
}

class SignalReconnectError extends Error {}

export type EngineEventCallbacks = {
  connected: (joinResp: JoinResponse) => void;
  disconnected: (reason?: DisconnectReason) => void;
  resuming: () => void;
  resumed: () => void;
  restarting: () => void;
  restarted: () => void;
  signalResumed: () => void;
  signalRestarted: (joinResp: JoinResponse) => void;
  closing: () => void;
  mediaTrackAdded: (
    track: MediaStreamTrack,
    streams: MediaStream,
    receiver?: RTCRtpReceiver,
  ) => void;
  activeSpeakersUpdate: (speakers: Array<SpeakerInfo>) => void;
  dataPacketReceived: (userPacket: UserPacket, kind: DataPacket_Kind) => void;
  transportsCreated: (publisher: PCTransport, subscriber: PCTransport) => void;
  /** @internal */
  trackSenderAdded: (track: Track, sender: RTCRtpSender) => void;
  rtpVideoMapUpdate: (rtpMap: Map<number, VideoCodec>) => void;
  dcBufferStatusChanged: (isLow: boolean, kind: DataPacket_Kind) => void;
  participantUpdate: (infos: ParticipantInfo[]) => void;
  roomUpdate: (room: RoomModel) => void;
  connectionQualityUpdate: (update: ConnectionQualityUpdate) => void;
  speakersChanged: (speakerUpdates: SpeakerInfo[]) => void;
  streamStateChanged: (update: StreamStateUpdate) => void;
  subscriptionError: (resp: SubscriptionResponse) => void;
  subscriptionPermissionUpdate: (update: SubscriptionPermissionUpdate) => void;
};
