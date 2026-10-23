#!/bin/bash
# Sobe as funções e as regras da Calculadora REAL (projeto calculadora-real-produto)
set -e
cd "$(dirname "$0")"
P=calculadora-real-produto
F="npx -y firebase-tools@latest"

echo ""; echo "== Instalando dependências... =="
(cd functions && npm install --silent)

if ! $F projects:list --project $P >/dev/null 2>&1; then
  echo ""; echo "== Faça login no Firebase (abra o link, autorize e cole o código aqui) =="
  $F login --no-localhost
fi

echo ""; echo "== 1/2: cole o CLIENT SECRET do Mercado Livre e aperte Enter =="
$F functions:secrets:set ML_CLIENT_SECRET --project $P

echo ""; echo "== 2/2: cole o TOKEN do webhook da Kiwify e aperte Enter =="
$F functions:secrets:set KIWIFY_TOKEN --project $P

echo ""; echo "== Publicando funções e regras (leva uns 3 a 5 minutos)... =="
$F deploy --only functions,firestore:rules --project $P --force

echo ""
echo "PRONTO! URL do webhook para a Kiwify:"
echo "https://southamerica-east1-$P.cloudfunctions.net/kiwifyWebhook"
