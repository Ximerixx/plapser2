#!/usr/bin/env bash
set -euo pipefail

KEY_ID="${1:-1}"
OUT_DIR="${2:-.}"

PRIVATE="upload_private_${KEY_ID}.pem"
PUBLIC="upload_public_${KEY_ID}.pem"

openssl genpkey -algorithm ED25519 -out "${OUT_DIR}/${PRIVATE}"
openssl pkey -in "${OUT_DIR}/${PRIVATE}" -pubout -out "${OUT_DIR}/${PUBLIC}"

echo "Generated:"
echo "  private: ${OUT_DIR}/${PRIVATE}  (keep on CI only, never commit)"
echo "  public:  ${OUT_DIR}/${PUBLIC}    (deploy to server app_manager/keys/)"
