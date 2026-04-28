FROM journeyapps/powersync-service:latest
USER root
COPY docker/powersync/tls-preload.cjs /opt/powersync/tls-preload.cjs
RUN chmod 0644 /opt/powersync/tls-preload.cjs
ENV NODE_OPTIONS="--require=/opt/powersync/tls-preload.cjs"
USER 1001
