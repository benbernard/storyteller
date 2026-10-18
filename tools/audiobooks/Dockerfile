FROM node:22-bookworm-slim AS build
ARG NPM_CONFIG_REGISTRY=https://registry.npmjs.org
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate
WORKDIR /app
COPY tools/audiobooks/package.json tools/audiobooks/pnpm-lock.yaml tools/audiobooks/pnpm-workspace.yaml ./
RUN --mount=type=cache,id=homelab-pnpm-10,target=/pnpm/store,sharing=locked pnpm install --store-dir=/pnpm/store --package-import-method=copy --frozen-lockfile --ignore-scripts
COPY tools/audiobooks/tsconfig.json ./
COPY tools/audiobooks/src ./src
RUN pnpm run build

FROM node:22-bookworm-slim AS royal-road
ARG NPM_CONFIG_REGISTRY=https://registry.npmjs.org
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate
WORKDIR /royal-road
COPY tools/royal-road/package.json tools/royal-road/pnpm-lock.yaml tools/royal-road/pnpm-workspace.yaml ./
RUN --mount=type=cache,id=homelab-pnpm-10,target=/pnpm/store,sharing=locked pnpm install --store-dir=/pnpm/store --package-import-method=copy --frozen-lockfile --ignore-scripts
COPY tools/royal-road/tsconfig.json ./
COPY tools/royal-road/src ./src
RUN --mount=type=cache,id=homelab-pnpm-10,target=/pnpm/store,sharing=locked pnpm run build && pnpm install --store-dir=/pnpm/store --package-import-method=copy --frozen-lockfile --prod --ignore-scripts

FROM node:22-bookworm-slim AS runtime
ARG NPM_CONFIG_REGISTRY=https://registry.npmjs.org
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates ffmpeg python3 poppler-utils \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /app/package.json /app/pnpm-lock.yaml /app/pnpm-workspace.yaml ./
RUN --mount=type=cache,id=homelab-pnpm-10,target=/pnpm/store,sharing=locked pnpm install --store-dir=/pnpm/store --package-import-method=copy --frozen-lockfile --prod --ignore-scripts
COPY --from=build /app/dist ./dist
COPY --from=royal-road /royal-road /royal-road
COPY tools/mac-tts/local_book.py tools/mac-tts/tts_typing.py /mac-tts/
COPY tools/audiobooks/listener-web ./listener-web
COPY tools/audiobooks/examples ./examples
ARG REVISION=development
LABEL org.opencontainers.image.revision=$REVISION
ENV AUDIOBOOK_STATE=/state
ENTRYPOINT ["node", "dist/cli.js"]
