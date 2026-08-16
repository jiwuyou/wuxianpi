import { HubDatabase } from "./database.js";
import { loadConfig } from "./config.js";
import { RealGitGateway } from "./git.js";
import { RealGitHubAuthGateway } from "./github-auth.js";
import { FetchDownloadVerifier, VerifiedAssetStore } from "./metadata.js";
import { HubAuthService } from "./auth-service.js";
import { createHubServer } from "./server.js";
import { HubService } from "./service.js";
import { PackageValidator } from "./validator.js";
import { HttpHubMirrorClient } from "./mirror-client.js";

const config = loadConfig();
const database = new HubDatabase(config.dbPath);
const assetStore = new VerifiedAssetStore(config.assetDir);
const validator = new PackageValidator({
  schema: config.packageSchema,
  downloader: new FetchDownloadVerifier(),
  assetStore,
  maxDownloadBytes: config.maxDownloadBytes,
});
const mirror = config.mirrorServiceUrl && config.mirrorServiceToken
  ? new HttpHubMirrorClient(config.mirrorServiceUrl, config.mirrorServiceToken)
  : null;
const service = new HubService({
  database,
  git: new RealGitGateway(),
  validator,
  publicUrl: config.publicUrl,
  ...(mirror ? { mirror } : {}),
});
const authService = new HubAuthService({
  database,
  github: new RealGitHubAuthGateway(),
  githubClientId: config.githubClientId,
  sessionDays: config.sessionDays,
});
service.resumePendingSubmissions();
const server = createHubServer({
  service,
  authService,
  database,
  publicDir: config.publicDir,
  adminToken: config.adminToken,
  publisherCredentials: config.publisherCredentials,
  assetStore,
});

server.listen(config.port, config.host, () => {
  console.log(`WuxianPi Hub listening on http://${config.host}:${config.port}`);
});

const shutdown = () => {
  server.close(() => {
    database.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
};

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
