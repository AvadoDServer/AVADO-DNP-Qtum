# Build Wizard
FROM node:15.6.0 as wizard-builder

RUN apt-get update && apt-get install -y openssl

WORKDIR /package/wizard
COPY wizard .
RUN yarn install
RUN yarn build

WORKDIR /package/monitor
COPY monitor .
RUN yarn install

# Build Wallet
FROM node:15.6.0 as web-wallet-builder

WORKDIR /package/wallet
RUN git clone https://github.com/qtumproject/qtum-web-wallet .

# Final image
FROM golang:1.13.4-buster

ARG VERSION

RUN set -ex \
    && apt-get update \
    && apt-get install -y -qq --no-install-recommends ca-certificates curl wget apt-utils jq nodejs npm yarn supervisor nginx

RUN set -ex \
    && echo `curl -s https://api.github.com/repos/qtumproject/qtum/releases/tags/$VERSION | jq -r ".assets[] | select(.name | test(\"x86_64-linux-gnu.tar.gz\")) | .browser_download_url"` > /tmp/qtum_url \
    && QTUM_URL=`cat /tmp/qtum_url` \
    && QTUM_DIST=$(basename $QTUM_URL) \
    && wget -O $QTUM_DIST $QTUM_URL \
	&& tar -xzvf $QTUM_DIST -C /usr/local --strip-components=1 \
	&& rm /tmp/qtum*

ENV QTUM_CONF_PATH=/package/data/qtum.conf
ENV QTUM_DATA_PATH=/package/data/qtum

COPY files/qtum.conf $QTUM_CONF_PATH

# Download certs
RUN mkdir /cert
RUN wget -O /cert/server.crt http://iso.ava.do/server.crt
RUN wget -O /cert/server.key  http://iso.ava.do/server.key

# Copy supervisor and nginx configs
COPY files/supervisord.conf /etc/supervisord/
COPY files/nginx.conf /etc/nginx/

RUN mkdir -p /etc/nginx/certs/
RUN mv /cert/server.* /etc/nginx/certs/
RUN useradd nginx

RUN mkdir -p /package/wizard
COPY --from=wizard-builder /package/wizard/build /package/wizard
COPY --from=wizard-builder /package/monitor /package/monitor
COPY --from=web-wallet-builder /package/wallet/dist /package/wallet

ENTRYPOINT supervisord -n -c /etc/supervisord/supervisord.conf