# Build Wizard
FROM node:16 as wizard-builder

RUN apt-get update && apt-get install -y openssl

WORKDIR /package/wizard
COPY wizard .
RUN yarn install
RUN yarn build

WORKDIR /package/monitor
COPY monitor .
RUN yarn install

# Build Wallet
FROM node:16 as web-wallet-builder

WORKDIR /package/wallet
RUN git clone https://github.com/qtumproject/qtum-web-wallet .

# Final image
FROM --platform=linux/amd64 golang:1.13.4-buster

ARG VERSION

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
