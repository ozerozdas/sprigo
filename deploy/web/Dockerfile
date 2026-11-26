FROM node:22-bookworm-slim@sha256:be979e5523c76fa4d5ca4ebd3099078f220aa47ec39c48ad5b5df9314debd6eb AS build
WORKDIR /src
RUN npm install -g pnpm@10
COPY package.json pnpm-lock.yaml ./
COPY patches ./patches
RUN pnpm install --frozen-lockfile
COPY . .
ENV VITE_STANDALONE_WEB=1
RUN pnpm build

FROM python:3.12-slim@sha256:191083cdf6c7bda8c76158983163ead5d5cf7b77cf3033e805bb0f5296f51b4b
WORKDIR /app
RUN pip install --no-cache-dir faster-whisper==1.2.1 av==18.1.0
COPY --from=build /src/dist /app/dist
COPY deploy/web/server.py /app/
# Same UID/GID as compose.yaml's default, so ./models stays writable.
RUN groupadd -g 1000 app && useradd -u 1000 -g app -d /app/models -M app && mkdir -p /app/models && chown app:app /app/models
USER app
EXPOSE 1431 1432
# ponytail: TLS is self-signed, so the probe skips verification; it only checks the server answers.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD ["python", "-c", "import ssl,urllib.request;urllib.request.urlopen('https://127.0.0.1:1431/health',context=ssl._create_unverified_context(),timeout=4)"]
CMD ["python", "-u", "/app/server.py"]
