#!/bin/sh
# Runs INSIDE an old Qtum Core image (qtum/qtum:22.1) that still creates
# legacy (Berkeley DB) wallets. Called by generate.sh; regtest only, the keys
# hold no real coins. Writes to /out:
#   regtest/            the regtest data directory (chain + wallets/<name>/wallet.dat)
#   <name>.dumpwallet   `dumpwallet` of each wallet (ground truth)
#   <name>.info.json    balances, labels and wallet info (ground truth)
set -eu
D=/out
CLI="qtum-cli -regtest -datadir=$D"
EXT_WIF_COMPRESSED=$1     # keys made by generate.sh, imported into the wallets
EXT_WIF_UNCOMPRESSED=$2
NONHD_WIF_1=$3
NONHD_WIF_2=$4
NONHD_WIF_3_UNCOMPRESSED=$5
ENC_PASSPHRASE=$6

# -addrindex and -logevents: the package runs qtumd with -superstaking, which needs both
qtumd -regtest -datadir=$D -daemon -keypool=20 -fallbackfee=0.001 -addrindex=1 -logevents=1 -printtoconsole=0
for i in $(seq 1 60); do $CLI getblockchaininfo >/dev/null 2>&1 && break; sleep 1; done

w() { name=$1; shift; $CLI -rpcwallet="$name" "$@"; }

# A miner wallet that only pays the others
$CLI createwallet miner >/dev/null
MINER=$(w miner getnewaddress "" legacy)

# hd-plain: HD wallet, used receive and change addresses, labels
$CLI createwallet hd-plain >/dev/null
for i in 1 2 3 4 5 6; do
    a=$(w hd-plain getnewaddress "" legacy)
    $CLI generatetoaddress 1 "$a" >/dev/null
done
w hd-plain setlabel "$a" "Savings"
w hd-plain getnewaddress "Staking" legacy >/dev/null
w hd-plain getrawchangeaddress legacy >/dev/null
w hd-plain getrawchangeaddress legacy >/dev/null
# an address book entry for someone else's address (a "send" label)
w hd-plain setlabel "$(w miner getnewaddress)" "Exchange" >/dev/null

# hd-encrypted: HD wallet, encrypted after its first addresses (Qtum then
# switches to a new HD seed; the old one stays as an inactive chain)
$CLI createwallet hd-encrypted >/dev/null
for i in 1 2 3; do
    a=$(w hd-encrypted getnewaddress "" legacy)
    $CLI generatetoaddress 1 "$a" >/dev/null
done
w hd-encrypted setlabel "$a" "Before encryption"
w hd-encrypted encryptwallet "$ENC_PASSPHRASE" >/dev/null
sleep 2
for i in 1 2; do
    a=$(w hd-encrypted getnewaddress "" legacy)
    $CLI generatetoaddress 1 "$a" >/dev/null
done
w hd-encrypted setlabel "$a" "After encryption"

# hd-imported: HD wallet plus imported keys (one uncompressed) and a
# watch-only address
$CLI createwallet hd-imported >/dev/null
for i in 1 2 3; do
    a=$(w hd-imported getnewaddress "" legacy)
    $CLI generatetoaddress 1 "$a" >/dev/null
done
w hd-imported importprivkey "$EXT_WIF_COMPRESSED" "Imported key" false
w hd-imported importprivkey "$EXT_WIF_UNCOMPRESSED" "Old paper wallet" false
# a label longer than a quarter page: Berkeley DB keeps it on overflow pages
w hd-imported setlabel "$a" "$(for i in $(seq 1 450); do printf 'Long label '; done)"
w hd-imported importaddress "$(w miner getnewaddress "" legacy)" "Watched" false

# nonhd: no HD seed at all, only imported keys
$CLI -named createwallet wallet_name=nonhd blank=true >/dev/null
w nonhd importprivkey "$NONHD_WIF_1" "First" false
w nonhd importprivkey "$NONHD_WIF_2" "" false
w nonhd importprivkey "$NONHD_WIF_3_UNCOMPRESSED" "Uncompressed" false

# coins (regtest coinbase matures after 2000 blocks): mature coinbase for every wallet, then spend some so that change
# outputs land on the internal chain
for wallet in hd-plain hd-encrypted hd-imported; do
    $CLI generatetoaddress 2 "$(w $wallet getnewaddress "" legacy)" >/dev/null
done
for wif_addr in $(w hd-imported getaddressesbylabel "Imported key" | grep -o '"[qQ][^"]*"' | tr -d '"') \
                $(w hd-imported getaddressesbylabel "Old paper wallet" | grep -o '"[qQ][^"]*"' | tr -d '"') \
                $(w nonhd getaddressesbylabel "First" | grep -o '"[qQ][^"]*"' | tr -d '"') \
                $(w nonhd getaddressesbylabel "Uncompressed" | grep -o '"[qQ][^"]*"' | tr -d '"'); do
    $CLI generatetoaddress 1 "$wif_addr" >/dev/null
done
$CLI generatetoaddress 2010 "$MINER" >/dev/null
w hd-plain sendtoaddress "$(w miner getnewaddress)" 1.5 >/dev/null
w hd-plain sendtoaddress "$(w hd-plain getnewaddress "" legacy)" 2.25 >/dev/null
w hd-encrypted walletpassphrase "$ENC_PASSPHRASE" 60
w hd-encrypted sendtoaddress "$(w miner getnewaddress)" 3 >/dev/null
w hd-encrypted walletlock
$CLI generatetoaddress 1 "$MINER" >/dev/null
sleep 2

for wallet in hd-plain hd-encrypted hd-imported nonhd; do
    [ $wallet = hd-encrypted ] && w $wallet walletpassphrase "$ENC_PASSPHRASE" 60
    w $wallet dumpwallet "/out/$wallet.dumpwallet" >/dev/null
    [ $wallet = hd-encrypted ] && w $wallet walletlock
    {
        echo "{\"balances\": $(w $wallet getbalances),"
        echo "\"walletinfo\": $(w $wallet getwalletinfo),"
        echo "\"labels\": {"
        sep=""
        w $wallet listlabels | sed -n 's/^ *"\(.*\)",\{0,1\}$/\1/p' | while IFS= read -r label; do
            printf '%s"%s": %s\n' "$sep" "$label" "$(w $wallet getaddressesbylabel "$label")"
            sep=","
        done
        echo "}}"
    } > "/out/$wallet.info.json"
done
$CLI getblockchaininfo > /out/chain.json
$CLI stop >/dev/null
for i in $(seq 1 60); do [ -f $D/regtest/qtumd.pid ] || break; sleep 1; done
sleep 2
