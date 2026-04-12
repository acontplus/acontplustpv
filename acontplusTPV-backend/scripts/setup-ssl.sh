#!/bin/bash
# =============================================================================
# scripts/setup-ssl.sh
# Script de configuración inicial de TLS con Let's Encrypt
#
# EJECUTAR UNA SOLA VEZ en el primer deploy en el VPS.
# Prerequisito: el dominio ya debe apuntar a la IP del VPS (DNS propagado).
#
# Uso:
#   chmod +x scripts/setup-ssl.sh
#   ./scripts/setup-ssl.sh
# =============================================================================

set -euo pipefail

# ── Cargar variables desde .env ───────────────────────────────────────────────
if [ ! -f .env ]; then
  echo "ERROR: archivo .env no encontrado. Copia .env.example y complétalo."
  exit 1
fi

# Extraer dominios y email del .env
API_DOMAIN=$(grep NGINX_API_DOMAIN .env | cut -d= -f2)
POWERSYNC_DOMAIN=$(grep NGINX_POWERSYNC_DOMAIN .env | cut -d= -f2)
ADMIN_DOMAIN=$(grep NGINX_ADMIN_DOMAIN .env | cut -d= -f2)
EMAIL=$(grep LETSENCRYPT_EMAIL .env | cut -d= -f2)

if [ -z "$API_DOMAIN" ] || [ -z "$EMAIL" ]; then
  echo "ERROR: NGINX_API_DOMAIN y LETSENCRYPT_EMAIL deben estar definidos en .env"
  exit 1
fi

echo "==================================================="
echo " acontplusTPV — Configuración inicial de TLS"
echo "==================================================="
echo " API domain:       $API_DOMAIN"
echo " PowerSync domain: $POWERSYNC_DOMAIN"
echo " Admin domain:     $ADMIN_DOMAIN"
echo " Email:            $EMAIL"
echo "==================================================="
echo ""

# ── Paso 1: Arrancar solo Nginx en modo HTTP (sin TLS) ────────────────────────
# Los certificados aún no existen — Nginx necesita arrancar solo con
# la configuración HTTP (puerto 80) para que Certbot pueda validar.
# Temporalmente usamos una configuración sin SSL.
echo "[1/4] Iniciando Nginx en modo HTTP para validación ACME..."

# Arrancar Nginx (usará la configuración con redirección a HTTPS,
# pero los bloques SSL fallarán si los certs no existen)
# Crear certificados dummy para que Nginx arranque sin error:
mkdir -p ./nginx/certs-dummy/live/{api,powersync,admin}
for DOMAIN in "$API_DOMAIN" "$POWERSYNC_DOMAIN" "$ADMIN_DOMAIN"; do
  CERT_DIR="./nginx/certs-dummy/live/$DOMAIN"
  mkdir -p "$CERT_DIR"
  if [ ! -f "$CERT_DIR/fullchain.pem" ]; then
    openssl req -x509 -nodes -newkey rsa:2048 \
      -keyout "$CERT_DIR/privkey.pem" \
      -out    "$CERT_DIR/fullchain.pem" \
      -days 1 -subj "/CN=$DOMAIN" 2>/dev/null
    cp "$CERT_DIR/fullchain.pem" "$CERT_DIR/chain.pem"
    echo "  Certificado dummy creado para $DOMAIN"
  fi
done

docker compose up -d nginx
sleep 3
echo "  Nginx iniciado."

# ── Paso 2: Obtener certificados reales con Certbot ───────────────────────────
echo ""
echo "[2/4] Obteniendo certificados Let's Encrypt..."

docker compose -f docker-compose.yml -f docker-compose.certbot.yml \
  run --rm certbot certonly \
  --webroot \
  --webroot-path /var/www/acme-challenge \
  -d "$API_DOMAIN" \
  -d "$POWERSYNC_DOMAIN" \
  -d "$ADMIN_DOMAIN" \
  --email "$EMAIL" \
  --agree-tos \
  --no-eff-email \
  --non-interactive

echo "  Certificados obtenidos exitosamente."

# ── Paso 3: Recargar Nginx con los certificados reales ────────────────────────
echo ""
echo "[3/4] Recargando Nginx con certificados TLS reales..."
docker compose exec nginx nginx -s reload
echo "  Nginx recargado."

# ── Paso 4: Configurar renovación automática en cron ──────────────────────────
echo ""
echo "[4/4] Configurando renovación automática en cron..."

CRON_JOB="0 3 * * * cd $(pwd) && docker compose -f docker-compose.yml -f docker-compose.certbot.yml run --rm certbot renew --quiet && docker compose exec nginx nginx -s reload >> /var/log/certbot-renew.log 2>&1"

# Agregar el cron solo si no existe ya
( crontab -l 2>/dev/null | grep -v "certbot renew" ; echo "$CRON_JOB" ) | crontab -
echo "  Cron configurado: renovación automática cada día a las 3:00 AM."

echo ""
echo "==================================================="
echo " ✅ TLS configurado exitosamente"
echo " Verificar en: https://$API_DOMAIN/health"
echo "==================================================="
