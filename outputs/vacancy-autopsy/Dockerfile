FROM node:22-bookworm-slim AS application

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-venv ca-certificates libgomp1 util-linux \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
# tsx is used at runtime; Vite and TypeScript are needed while building.
RUN npm ci --include=dev
COPY ml/requirements-tinker.txt ml/requirements-tabpfn.txt deploy/requirements-runtime.txt ./deploy/
RUN python3 -m venv /opt/model-env \
    && /opt/model-env/bin/pip install --no-cache-dir \
       -r deploy/requirements-tinker.txt -r deploy/requirements-tabpfn.txt \
       -r deploy/requirements-runtime.txt
COPY deploy/cache-tokenizer.py ./deploy/cache-tokenizer.py
RUN /opt/model-env/bin/python deploy/cache-tokenizer.py /opt/tokenizers
COPY . .
RUN npm run build && chown -R node:node /app
ENV NODE_ENV=production \
    PYTHONDONTWRITEBYTECODE=1 \
    TINKER_PYTHON=/opt/model-env/bin/python \
    TABPFN_PYTHON=/opt/model-env/bin/python \
    TINKER_TOKENIZER_CACHE=/opt/tokenizers
EXPOSE 10000
# Root only prepares the mounted disk, then start.sh drops to the node user.
ENTRYPOINT ["sh", "deploy/start.sh"]
CMD ["node", "--import", "tsx", "src/server/index.ts"]
