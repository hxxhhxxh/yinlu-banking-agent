# 银枢 · AI银行副驾 —— 容器镜像（零第三方依赖，仅需 Node 运行时）
FROM node:20-alpine

# 目录
WORKDIR /app

# 直接拷贝源码（本项目无 npm 依赖，无需单独 install 层）
COPY package.json ./
COPY server ./server
COPY public ./public
COPY scripts ./scripts
COPY docs ./docs
COPY index.html ./
COPY README.md ./

# 容器内需要监听 0.0.0.0；端口由平台通过 PORT 注入
ENV NODE_ENV=production \
    PORT=8787 \
    HOST=0.0.0.0

# 运行时状态目录（云平台可挂载卷持久化；不挂载则为容器生命周期内有效）
RUN mkdir -p /app/data
VOLUME ["/app/data"]

EXPOSE 8787

# 健康检查：云平台可用 /api/health 判定就绪
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# 沙箱演示：无需数据库、无需联网、无需构建
CMD ["node", "server/index.js"]
