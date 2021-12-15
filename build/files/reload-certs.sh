#!/bin/sh

date > /tmp/nginx-restarted.txt

wget -O /etc/nginx/certs/my.ava.do.crt http://iso.ava.do/my.ava.do.crt
wget -O /etc/nginx/certs/my.ava.do.key  http://iso.ava.do/my.ava.do.key

if [ -e /var/run/nginx.pid ]
then
  nginx -s reload
fi

