/**
 * La cuenta del código que restablece el PIN de admin (ver rescate.js). La usan la app
 * y el generador de Soprint (herramientas/hacer-generador.mjs la copia tal cual en su
 * página), así que las dos cuentan igual por construcción.
 *
 * Código = HMAC-SHA256(clave, "vizo-pin-admin|SERIE|solicitud"), 4 primeros bytes
 * como número, módulo 10^6: seis cifras.
 */
import { bytesDe, hmacSha256 } from './sha256.js';

export const CIFRAS_CODIGO = 6;

export function respuesta(clave, serie, solicitud) {
    const m = hmacSha256(bytesDe(clave), bytesDe('vizo-pin-admin|' + String(serie).toUpperCase() + '|' + solicitud));
    const n = (((m[0] << 24) | (m[1] << 16) | (m[2] << 8) | m[3]) >>> 0);
    return String(n % 1000000).padStart(CIFRAS_CODIGO, '0');
}

/** 123456 -> "123 456", para leerlo por teléfono. */
export function enGrupos(s) {
    return String(s).replace(/(\d{3})(?=\d)/g, '$1 ');
}
