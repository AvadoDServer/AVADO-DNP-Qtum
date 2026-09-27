# Build Wizard
FROM node:16-bullseye as wizard-builder

# Debian 11 (bullseye) reached its end of life on 2026-08-31. Its security
# updates were removed from deb.debian.org, and the rest will follow. Use the
# permanent locations instead: archive.debian.org for bullseye and
# bullseye-updates (the same package lists as deb.debian.org), and the final
# state of bullseye-security from snapshot.debian.org. The build fails if the
# base image lists other sources.
ARG DEBIAN_SECURITY_SNAPSHOT=20260831T000000Z
RUN sed -i \
        -e "s#^deb http://deb.debian.org/debian-security #deb http://snapshot.debian.org/archive/debian-security/${DEBIAN_SECURITY_SNAPSHOT} #" \
        -e "s#^deb http://deb.debian.org/debian #deb http://archive.debian.org/debian #" \
        /etc/apt/sources.list \
    && ! grep -q "^deb http://deb.debian.org" /etc/apt/sources.list \
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

# Qtum Core release tag (e.g. v30.2) and the sha256 of its x86_64-linux-gnu tarball
ARG VERSION
ARG QTUM_SHA256
# Qtum Core v29.1: only its wallet tool is kept. It is used to flush a legacy
# wallet that was not closed cleanly, before the automatic upgrade to a
# descriptor wallet (Qtum v30 cannot read such a legacy wallet).
ARG QTUM_LEGACY_VERSION=v29.1
ARG QTUM_LEGACY_SHA256=c04e3f49c8e21a7c910b2373f9a540794eca262c83a5afbe040e38b3f5b2da4b

# Debian 11 (bullseye) reached its end of life on 2026-08-31. Its security
# updates were removed from deb.debian.org, and the rest will follow. Use the
# permanent locations instead: archive.debian.org for bullseye and
# bullseye-updates (the same package lists as deb.debian.org), and the final
# state of bullseye-security from snapshot.debian.org. The build fails if the
# base image lists other sources.
ARG DEBIAN_SECURITY_SNAPSHOT=20260831T000000Z
RUN sed -i \
        -e "s#^deb http://deb.debian.org/debian-security #deb http://snapshot.debian.org/archive/debian-security/${DEBIAN_SECURITY_SNAPSHOT} #" \
        -e "s#^deb http://deb.debian.org/debian #deb http://archive.debian.org/debian #" \
        /etc/apt/sources.list \
    && ! grep -q "^deb http://deb.debian.org" /etc/apt/sources.list \
    && echo 'Acquire::Check-Valid-Until "false";' > /etc/apt/apt.conf.d/99snapshot-valid-until
RUN set -ex \
    && apt-get update \
    && apt-get install -y -qq --no-install-recommends ca-certificates curl wget apt-utils jq nodejs npm cron yarn supervisor nginx

RUN set -ex \
    && test -n "$VERSION" && test -n "$QTUM_SHA256" \
    && QTUM_DIST="qtum-${VERSION#v}-x86_64-linux-gnu.tar.gz" \
    && wget -q -O "/tmp/$QTUM_DIST" "https://github.com/qtumproject/qtum/releases/download/${VERSION}/${QTUM_DIST}" \
    && echo "${QTUM_SHA256}  /tmp/${QTUM_DIST}" | sha256sum -c - \
    && tar -xzf "/tmp/$QTUM_DIST" -C /usr/local --strip-components=1 \
    && rm "/tmp/$QTUM_DIST" \
    && qtumd -version | head -n1 | grep -F "${VERSION}."

RUN set -ex \
    && QTUM_DIST="qtum-${QTUM_LEGACY_VERSION#v}-x86_64-linux-gnu.tar.gz" \
    && wget -q -O "/tmp/$QTUM_DIST" "https://github.com/qtumproject/qtum/releases/download/${QTUM_LEGACY_VERSION}/${QTUM_DIST}" \
    && echo "${QTUM_LEGACY_SHA256}  /tmp/${QTUM_DIST}" | sha256sum -c - \
    && mkdir -p /usr/local/lib/qtum-legacy \
    && tar -xzf "/tmp/$QTUM_DIST" -C /usr/local/lib/qtum-legacy --strip-components=2 "qtum-${QTUM_LEGACY_VERSION#v}/bin/qtum-wallet" \
    && rm "/tmp/$QTUM_DIST" \
    && /usr/local/lib/qtum-legacy/qtum-wallet -version | head -n1 | grep -F "${QTUM_LEGACY_VERSION}."

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

ENTRYPOINT ["/entrypoint.sh"]
