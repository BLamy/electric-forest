FROM node:24.20.0-bookworm-slim@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e AS build
WORKDIR /app
RUN npm install --global pnpm@10.15.0
COPY . .
RUN pnpm install --frozen-lockfile
# Verify real Linux native binaries instead of trusting install-time warnings.
RUN node --input-type=module -e 'import {createRequire} from "node:module"; const serverRequire=createRequire(new URL("./packages/server/package.json", import.meta.url)); const lmdb=createRequire(serverRequire.resolve("@durable-streams/server"))("lmdb"); const db=lmdb.open({path:"/tmp/preview-native-check"}); db.putSync("native","linux"); if(db.get("native")!=="linux") process.exit(1); db.close(); const webRequire=createRequire(new URL("./apps/web/package.json",import.meta.url)); const esbuild=createRequire(webRequire.resolve("vite"))("esbuild"); esbuild.transformSync("const value: number = 1",{loader:"ts"});'
RUN pnpm build
ARG RAILWAY_GIT_COMMIT_SHA
ARG EF_BUILD_REVISION=${RAILWAY_GIT_COMMIT_SHA}
RUN node -e 'if(!/^[0-9a-f]{40}$/.test(process.argv[1]??"")) throw new Error("full build revision required"); require("node:fs").writeFileSync("build-revision",process.argv[1]+"\n")' "$EF_BUILD_REVISION"
# Runtime contains built assets and workspace modules; no workshops or auth homes.
RUN rm -rf .eforest tools docs apps/web/src apps/web/test packages/*/src packages/*/test packages/*/fixtures

FROM node:24.20.0-bookworm-slim@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e AS preview
WORKDIR /app
COPY --from=build /app /app
ENV NODE_ENV=production EF_DEPLOYMENT_MODE=preview EF_PREVIEW_AUTH=fixture EF_PREVIEW_DATA_DIR=/data/forest-preview
EXPOSE 8080
CMD ["node", "packages/platform/dist/src/preview-bin.js"]
