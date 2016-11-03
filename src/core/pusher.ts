import AbstractRuntime from "runtimes/interface";
import Runtime from "runtime";
import Util from "./util";
import * as Collections from './utils/collections';
import Channels from './channels/channels';
import Channel from './channels/channel';
import {default as EventsDispatcher} from './events/dispatcher';
import Timeline from './timeline/timeline';
import TimelineSender from './timeline/timeline_sender';
import TimelineLevel from './timeline/level';
import * as StrategyBuilder from './strategies/strategy_builder';
import ConnectionManager from './connection/connection_manager';
import ConnectionManagerOptions from './connection/connection_manager_options';
import {PeriodicTimer} from './utils/timers';
import Defaults from './defaults';
import * as DefaultConfig from './config';
import Logger from './logger';
import Factory from './utils/factory';
import PusherOptions from './options';

export default class Pusher {

  /*  STATIC PROPERTIES */
  static instances : Pusher[]  = [];
  static isReady : boolean = false;
  static logToConsole : boolean = false;

  // for jsonp
  static Runtime : AbstractRuntime = Runtime;
  static ScriptReceivers : any  = (<any>Runtime).ScriptReceivers;
  static DependenciesReceivers : any = (<any>Runtime).DependenciesReceivers;
  static auth_callbacks: any = (<any>Runtime).auth_callbacks;

  static ready() {
    Pusher.isReady = true;
    for (var i = 0, l = Pusher.instances.length; i < l; i++) {
      Pusher.instances[i].connect();
    }
  }

  static log(message : any) {
    if (Pusher.logToConsole && global.console && global.console.log) {
      global.console.log(message);
    }
  }

  private static getClientFeatures() : string[] {
    return Collections.keys(
      Collections.filterObject(
        { "ws": Runtime.Transports.ws },
        function (t) { return t.isSupported({}); }
      )
    );
  }

  /* INSTANCE PROPERTIES */
  key: string;
  config: PusherOptions;
  channels: Channels;
  global_emitter: EventsDispatcher;
  sessionID: number;
  timeline: Timeline;
  timelineSender: TimelineSender;
  connection: ConnectionManager;
  timelineSenderTimer: PeriodicTimer;

  constructor(app_key : string, options : any) {
    checkAppKey(app_key);
    options = options || {};

    this.key = app_key;
    this.config = Collections.extend<PusherOptions>(
      DefaultConfig.getGlobalConfig(),
      options.cluster ? DefaultConfig.getClusterConfig(options.cluster) : {},
      options
    );

    this.channels = Factory.createChannels();
    this.global_emitter = new EventsDispatcher();
    this.sessionID = Math.floor(Math.random() * 1000000000);

    this.timeline = new Timeline(this.key, this.sessionID, {
      cluster: this.config.cluster,
      features: Pusher.getClientFeatures(),
      params: this.config.timelineParams || {},
      limit: 50,
      level: TimelineLevel.INFO,
      version: Defaults.VERSION
    });
    if (!this.config.disableStats) {
      this.timelineSender = Factory.createTimelineSender(this.timeline, {
        host: this.config.statsHost,
        path: "/timeline/v2/" + Runtime.TimelineTransport.name
      });
    }

    var getStrategy = (options)=> {
      var config = Collections.extend({}, this.config, options);
      return StrategyBuilder.build(
        Runtime.getDefaultStrategy(config), config
      );
    };

    this.connection = Factory.createConnectionManager(
      this.key,
      Collections.extend<ConnectionManagerOptions>(
        { getStrategy: getStrategy,
          timeline: this.timeline,
          activityTimeout: this.config.activity_timeout,
          pongTimeout: this.config.pong_timeout,
          unavailableTimeout: this.config.unavailable_timeout
        },
        this.config,
        { encrypted: this.isEncrypted() }
      )
    );

    this.connection.bind('connected', ()=> {
      this.subscribeAll();
      if (this.timelineSender) {
        this.timelineSender.send(this.connection.isEncrypted());
      }
    });
    this.connection.bind('message', (params)=> {
      var internal = (params.event.indexOf('pusher_internal:') === 0);
      if (params.channel) {
        var channel = this.channel(params.channel);
        if (channel) {
          channel.handleEvent(params.event, params.data);
        }
      }
      // Emit globally [deprecated]
      if (!internal) {
        this.global_emitter.emit(params.event, params.data);
      }
    });
    this.connection.bind('disconnected', ()=> {
      this.channels.disconnect();
    });
    this.connection.bind('error', (err)=> {
      Logger.warn('Error', err);
    });

    Pusher.instances.push(this);
    this.timeline.info({ instances: Pusher.instances.length });

    if (Pusher.isReady) {
      this.connect();
    }
  }

  channel(name : string) : Channel {
    return this.channels.find(name);
  }

  allChannels() : Channel[] {
    return this.channels.all();
  }

  connect() {
    this.connection.connect();

    if (this.timelineSender) {
      if (!this.timelineSenderTimer) {
        var encrypted = this.connection.isEncrypted();
        var timelineSender = this.timelineSender;
        this.timelineSenderTimer = new PeriodicTimer(60000, function() {
          timelineSender.send(encrypted);
        });
      }
    }
  }

  disconnect() {
    this.connection.disconnect();

    if (this.timelineSenderTimer) {
      this.timelineSenderTimer.ensureAborted();
      this.timelineSenderTimer = null;
    }
  }

  bind(event_name : string, callback : Function) : Pusher {
    this.global_emitter.bind(event_name, callback);
    return this;
  }

  unbind(event_name: string, callback: Function) : Pusher {
    this.global_emitter.unbind(event_name, callback);
    return this;
  }

  bind_all(callback : Function) : Pusher {
    this.global_emitter.bind_all(callback);
    return this;
  }

  subscribeAll() {
    var channelName;
    for (channelName in this.channels.channels) {
      if (this.channels.channels.hasOwnProperty(channelName)) {
        this.subscribe(channelName);
      }
    }
  }

  subscribe(channel_name : string) {
    var channel = this.channels.add(channel_name, this);
    if (this.connection.state === "connected") {
      channel.subscribe();
    }
    return channel;
  }

  unsubscribe(channel_name : string) {
    var channel = this.channels.find(channel_name);
    if (channel && channel.subscriptionPending) {
      channel.cancelSubscription();
    } else {
      channel = this.channels.remove(channel_name);
      if (channel && this.connection.state === "connected") {
        channel.unsubscribe();
      }
    }
  }

  send_event(event_name : string, data : any, channel?: string) {
    return this.connection.send_event(event_name, data, channel);
  }

  isEncrypted() : boolean {
    if (Runtime.getProtocol() === "https:") {
      return true;
    } else {
      return Boolean(this.config.encrypted);
    }
  }
}

function checkAppKey(key) {
  if (key === null || key === undefined) {
    throw "You must pass your app key when you instantiate Pusher.";
  }
}

Runtime.setup(Pusher);
