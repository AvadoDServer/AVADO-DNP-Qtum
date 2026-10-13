#!/bin/sh
# Runs INSIDE the package image (Qtum v30.2). Called by generate.sh.
# For each fixture wallet (/w/regtest/wallets/legacy-<name>) and the
# importdescriptors request the rebuild makes for it (/w/<name>.request.json):
#   <name>.descinfo.json  getdescriptorinfo of every descriptor of the request
#   <name>.rebuilt.json   listdescriptors of a new wallet after the request
#   <name>.migrated.json  listdescriptors after Qtum's own `migratewallet`
set -eu
CLI="qtum-cli -regtest -datadir=/w"
qtumd -regtest -datadir=/w -daemon -addrindex=1 -logevents=1 -printtoconsole=0 >/dev/null
for i in $(seq 1 60); do $CLI getblockchaininfo >/dev/null 2>&1 && break; sleep 1; done
for name in hd-plain hd-encrypted hd-imported nonhd; do
    {
        echo "["
        sep=""
        jq -r '.[].desc | split("#")[0]' "/w/$name.request.json" | while IFS= read -r desc; do
            printf '%s%s\n' "$sep" "$($CLI getdescriptorinfo "$desc" | jq -c '{descriptor, checksum}')"
            sep=","
        done
        echo "]"
    } > "/w/out/$name.descinfo.json"

    passphrase=""
    [ -f "/w/$name.passphrase" ] && passphrase=$(cat "/w/$name.passphrase")
    blank=true
    [ $name = nonhd ] && blank=false
    $CLI -named createwallet wallet_name="rebuilt-$name" blank=$blank passphrase="$passphrase" \
        descriptors=true load_on_startup=false >/dev/null
    [ -n "$passphrase" ] && $CLI -rpcwallet="rebuilt-$name" walletpassphrase "$passphrase" 600
    $CLI -rpcwallet="rebuilt-$name" -stdin importdescriptors < "/w/$name.request.json" \
        | jq -e 'all(.success)' >/dev/null
    $CLI -rpcwallet="rebuilt-$name" listdescriptors | jq '[.descriptors[] | {desc, active, internal}]' > "/w/out/$name.rebuilt.json"

    if [ -n "$passphrase" ]; then
        $CLI migratewallet "legacy-$name" "$passphrase" >/dev/null
    else
        $CLI migratewallet "legacy-$name" >/dev/null
    fi
    $CLI -rpcwallet="legacy-$name" listdescriptors | jq '[.descriptors[] | {desc, active, internal}]' > "/w/out/$name.migrated.json"
done
$CLI stop >/dev/null
sleep 3
