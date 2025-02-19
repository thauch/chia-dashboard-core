const http = require("http");
const http2 = require("http2");
const Koa = require("koa");
const KoaRouter = require("koa-router");
const koaBodyParser = require("koa-bodyparser");
const cors = require("@koa/cors");
const mongoose = require("mongoose");
const { v4: uuidv4 } = require("uuid");
const semver = require("semver");
const logger = require("./logger");
const config = require("./config");
const oAuth = require("./oauth");
const Satellite = require("./db/satellite");
const User = require("./db/user");
const ipMiddleware = require("../middleware/ip");
const loggingMiddleware = require("../middleware/logging");
const authenticationMiddleware = require("../middleware/authentication");
const satelliteAuthMiddleware = require("../middleware/satellite-auth");
const shareKeyAuthMiddleware = require("../middleware/share-key-auth");
const rateLimitMiddleware = require("../middleware/rate-limit");
const sentryService = require("./sentry-service");
const rateService = require("./rate-service");
const { default: axios } = require("axios");

const validServices = [
  "farmer",
  "harvester",
  "fullNode",
  "wallet",
  "plotter",
  "hpoolMiner",
];

class Api {
  constructor() {
    const app = new Koa();
    app.on("error", (err) => {
      logger.log({ level: "error", msg: `API | HTTP | Error: ${err.message}` });
      sentryService.captureException(err);
    });
    app.use(cors());
    app.use(
      koaBodyParser({
        jsonLimit: "10mb",
      })
    );

    app.use(ipMiddleware);
    app.use(loggingMiddleware);

    const router = new KoaRouter();
    router.use(
      rateLimitMiddleware({
        threshold: 9999999999,
        ttl: 60,
      })
    );

    router.get("/api/ping", this.onPing.bind(this));
    router.post("/api/oauth/token", this.onToken.bind(this));
    router.get("/api/rates", this.onRates.bind(this));

    router.patch(
      "/api/satellite",
      satelliteAuthMiddleware,
      this.onNewSatelliteStats.bind(this)
    );

    router.get(
      "/api/me",
      authenticationMiddleware({ fetchUser: true }),
      this.onGetUser.bind(this)
    );

    router.patch(
      "/api/me",
      authenticationMiddleware({ fetchUser: true }),
      this.onUpdateUser.bind(this)
    );

    router.get(
      "/api/satellites",
      authenticationMiddleware({ fetchUser: false }),
      this.onGetSatellites.bind(this)
    );

    router.get("/api/globalstats", this.onGetGlobalStats.bind(this));
    router.get("/api/stats", this.onGetChiaStats.bind(this));

    router.get(
      "/api/shared/satellites",
      shareKeyAuthMiddleware,
      this.onGetSatellites.bind(this)
    );

    router.post(
      "/api/satellite",
      authenticationMiddleware({ fetchUser: false }),
      this.onCreateSatellite.bind(this)
    );

    router.delete(
      "/api/satellite/:id",
      authenticationMiddleware({ fetchUser: false }),
      this.onDeleteSatellite.bind(this)
    );

    router.patch(
      "/api/satellite/:id",
      authenticationMiddleware({ fetchUser: false }),
      this.onUpdateSatellite.bind(this)
    );

    app.use(router.routes());
    app.use(router.allowedMethods());

    if (config.isSslEnabled) {
      this.server = http2.createSecureServer(
        {
          ...config.ssl,
          allowHTTP1: true,
        },
        app.callback()
      );
    } else {
      this.server = http.createServer(app.callback());
    }
  }

  async init() {
    await new Promise((resolve) =>
      this.server.listen(config.listenPort, config.listenHost, resolve)
    );

    logger.log({
      level: "info",
      msg: `API | Initialized and reachable on http${
        config.isSslEnabled ? "s" : ""
      }://${config.listenHost}:${config.listenPort}`,
    });
  }

  async onPing(ctx) {
    ctx.body = { success: true };
  }

  async onToken(ctx) {
    if (!ctx.request.body) {
      ctx.status = 400;
      ctx.body = { error: "Invalid request!" };
      return;
    }
    try {
      const { accessToken, refreshToken } = await oAuth.authenticate(
        ctx.request.body
      );

      ctx.body = {
        token_type: "Bearer",

        expires_in: 600,
        access_token: accessToken,
        refresh_token: refreshToken,
      };
    } catch (err) {
      ctx.status = 400;
      ctx.body = { error: err.message };
    }
  }

  async onGetUser(ctx) {
    ctx.body = ctx.user.toJSON();
  }

  async onGetSatellites(ctx) {
    const satellites = await Satellite.find({ user: ctx.userId });
    ctx.body = satellites.map((satellite) => satellite.toJSON());
  }

  async onGetGlobalStats(ctx) {
    const userTotal = await User.count();
    const satelliteTotal = await Satellite.count();
    ctx.body = {
      users: userTotal,
      satellites: satelliteTotal,
    };
  }

  async onGetChiaStats(ctx) {
    const netspace = await axios.get(
      "https://api.chiaprofitability.com/netspace"
    );

    console.log(netspace);

    ctx.body = netspace.data;
  }

  async onCreateSatellite(ctx) {
    const body = ctx.request.body;

    const id = new mongoose.Types.ObjectId();
    const satellite = new Satellite({
      _id: id,
      user: new mongoose.Types.ObjectId(ctx.userId),
      name: body.name,
      apiKey: uuidv4(),
      collapse: false,
      coin: body.coin,
      services: {},
    });
    await satellite.save();

    ctx.body = satellite.toJSON();
    ctx.body.apiKey = satellite.apiKey;
  }

  async onDeleteSatellite(ctx) {
    const satellite = await Satellite.findById(ctx.params.id);
    if (!satellite || satellite.user.toString() !== ctx.userId) {
      ctx.body = { error: `Satellite ${ctx.params.id} not found` };
      ctx.status = 400;
      return;
    }
    await Satellite.deleteOne({ _id: satellite.id });

    ctx.status = 204;
  }

  async onNewSatelliteStats(ctx) {
    const body = ctx.request.body;

    const satellite = ctx.satellite;
    if (!satellite.services) {
      satellite.services = {};
    }
    validServices
      .filter((service) => body[service] !== undefined)
      .forEach((service) => {
        if (!satellite.services[service]) {
          satellite.services[service] = {};
        }
        if (!body[service]) {
          satellite.services[service].stats = null;
        } else {
          satellite.services[service].stats = {
            ...(satellite.services[service].stats || {}),
            ...body[service],
          };
        }
        satellite.services[service].lastUpdate = new Date();
        satellite.markModified(`services.${service}.stats`);
      });

    const satelliteVersion = ctx.request.headers["satellite-version"];

    if (
      satelliteVersion &&
      satellite.version !== satelliteVersion &&
      semver.valid(satelliteVersion) &&
      (!satellite.version || semver.gt(satelliteVersion, satellite.version))
    ) {
      satellite.version = satelliteVersion;
    }
    await satellite.save();
    ctx.status = 204;
  }

  async onUpdateSatellite(ctx) {
    const satellite = await Satellite.findById(ctx.params.id);
    if (!satellite || satellite.user.toString() !== ctx.userId) {
      ctx.body = { error: `Satellite ${ctx.params.id} not found` };
      ctx.status = 400;

      return;
    }
    const body = ctx.request.body;
    let updated = false;
    if (body.name && satellite.name !== body.name) {
      satellite.name = body.name.toString();
      updated = true;
    }
    if (body.hidden !== undefined && satellite.hidden !== body.hidden) {
      satellite.hidden = !!body.hidden;
      updated = true;
    }

    if (
      body.collapsed !== undefined &&
      satellite.collapsed !== body.collapsed
    ) {
      satellite.collapsed = !!body.collapsed;
      updated = true;
    }
    if (updated) {
      await satellite.save();
    }

    ctx.status = 204;
  }

  async onUpdateUser(ctx) {
    const body = ctx.request.body;
    let updated = false;

    if (body.isShared !== undefined && body.isShared !== !!ctx.user.shareKey) {
      ctx.user.shareKey = body.isShared ? uuidv4() : null;
      updated = true;
    }
    if (
      body.satelliteOrder !== undefined &&
      body.satelliteOrder !== !!ctx.user.satelliteOrder
    ) {
      ctx.user.satelliteOrder = body.satelliteOrder;
      updated = true;
    }
    if (
      body.visibleGroups !== undefined &&
      body.visibleGroups !== !!ctx.user.visibleGroups
    ) {
      ctx.user.visibleGroups = body.visibleGroups;
      updated = true;
    }
    if (updated) {
      await ctx.user.save();
    }

    ctx.status = 204;
  }

  async onRates(ctx) {
    ctx.body = {
      rates: rateService.rates,
      currencies: rateService.currencies,
    };
  }
}

module.exports = new Api();
