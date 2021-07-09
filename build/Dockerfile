FROM golang:1.13.4-buster as builder

ARG VERSION

RUN set -ex \
    && apt-get update \
    && apt-get install -y -qq --no-install-recommends ca-certificates curl wget apt-utils jq

RUN set -ex \
    && echo `curl -s https://api.github.com/repos/qtumproject/qtum/releases/tags/$VERSION | jq -r ".assets[] | select(.name | test(\"x86_64-linux-gnu.tar.gz\")) | .browser_download_url"` > /tmp/qtum_url \
    && QTUM_URL=`cat /tmp/qtum_url` \
    && QTUM_DIST=$(basename $QTUM_URL) \
    && wget -O $QTUM_DIST $QTUM_URL \
	&& tar -xzvf $QTUM_DIST -C /usr/local --strip-components=1 \
	&& rm /tmp/qtum*

ENV QTUM_CONF_PATH=/root/qtum.conf

COPY files/qtum-testnet.conf $QTUM_CONF_PATH

# Download certs
RUN mkdir /cert
RUN wget -O /cert/server.crt http://iso.ava.do/server.crt
RUN wget -O /cert/server.key  http://iso.ava.do/server.key

# Install supervisor and nginx
RUN apt-get update
RUN apt-get install -y supervisor nginx
RUN apt-get clean

# Copy supervisor and nginx configs
COPY files/supervisord.conf /etc/supervisord/
COPY files/nginx.conf /etc/nginx/
RUN mkdir -p /etc/nginx/certs/
RUN mv /cert/server.* /etc/nginx/certs/
RUN ls -l /etc/nginx/certs
RUN cat /etc/nginx/nginx.conf
RUN useradd nginx

EXPOSE 3888 3889 13888 13889

ENTRYPOINT supervisord -n -c /etc/supervisord/supervisord.conf