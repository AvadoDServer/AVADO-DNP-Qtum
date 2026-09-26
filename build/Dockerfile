# Build Wizard
FROM node:16-bullseye as wizard-builder

# Debian 11 (bullseye) reached its end of life on 2026-08-31 and its security
# updates were removed from deb.debian.org. Use their final state from
# snapshot.debian.org instead.
ARG DEBIAN_SECURITY_SNAPSHOT=20260831T000000Z
RUN sed -i "s#http://deb.debian.org/debian-security#http://snapshot.debian.org/archive/debian-security/${DEBIAN_SECURITY_SNAPSHOT}#" /etc/apt/sources.list \
    && echo 'Acquire::Check-Valid-Until "false";' > /etc/apt/apt.conf.d/99snapshot-valid-until
RUN apt-get update && apt-get install -y openssl

WORKDIR /package/wizard
COPY wizard .
RUN yarn install --frozen-lockfile
RUN yarn build

WORKDIR /package/monitor
COPY monitor .
# yarn.lock = the dependency versions the 0.0.13 image shipped
RUN yarn install --frozen-lockfile

# Build Wallet
FROM node:16-bullseye as web-wallet-builder

# qtum-web-wallet, pinned to the commit the 0.0.13 image shipped
ARG QTUM_WEB_WALLET_COMMIT=bfbf809d474a1faa0953c3382dc82a8f6e19e848
WORKDIR /package/wallet
RUN git clone https://github.com/qtumproject/qtum-web-wallet . \
    && git checkout --detach ${QTUM_WEB_WALLET_COMMIT}

# Final image
FROM --platform=linux/amd64 golang:1.20-bullseye

ARG VERSION

# Debian 11 (bullseye) reached its end of life on 2026-08-31 and its security
# updates were removed from deb.debian.org. Use their final state from
# snapshot.debian.org instead.
ARG DEBIAN_SECURITY_SNAPSHOT=20260831T000000Z
RUN sed -i "s#http://deb.debian.org/debian-security#http://snapshot.debian.org/archive/debian-security/${DEBIAN_SECURITY_SNAPSHOT}#" /etc/apt/sources.list \
    && echo 'Acquire::Check-Valid-Until "false";' > /etc/apt/apt.conf.d/99snapshot-valid-until

RUN set -ex \
    && apt-get update \
    && apt-get install -y -qq --no-install-recommends ca-certificates curl wget apt-utils jq nodejs npm cron yarn supervisor nginx

RUN set -ex \
    && echo `curl -s https://api.github.com/repos/qtumproject/qtum/releases/tags/$VERSION | jq -r ".assets[] | select(.name | test(\"x86_64-linux-gnu.tar.gz\")) | .browser_download_url"` > /tmp/qtum_url \
    && QTUM_URL=`cat /tmp/qtum_url` \
    && QTUM_DIST=$(basename $QTUM_URL) \
    && wget -O $QTUM_DIST $QTUM_URL \
    && tar -xzvf $QTUM_DIST -C /usr/local --strip-components=1 \
    && rm /tmp/qtum*

RUN mkdir -p /package/data/qtum
ENV QTUM_CONF_PATH=/package/data/qtum.conf
ENV QTUM_DATA_PATH=/package/data/qtum

COPY files/qtum.conf $QTUM_CONF_PATH

# Copy supervisor and nginx configs
COPY files/supervisord.conf /etc/supervisord/
COPY files/nginx.conf /etc/nginx/

RUN useradd nginx
RUN mkdir -p /etc/nginx/certs/

# Add crontab script to reload certificates
COPY files/reload-certs.sh /reload-certs.sh
RUN chmod +x /reload-certs.sh

# Add crontab 
COPY files/crontab /etc/crontabs/root
RUN chmod 644 /etc/crontabs/root

# Copy monitor and wizard
RUN mkdir -p /package/wizard
COPY --from=wizard-builder /package/wizard/build /package/wizard
COPY --from=wizard-builder /package/monitor /package/monitor
COPY --from=web-wallet-builder /package/wallet/dist /package/wallet

# copy entrypoint
COPY files/entrypoint.sh /entrypoint.sh
RUN chmod 755 /entrypoint.sh

ENTRYPOINT /entrypoint.sh
