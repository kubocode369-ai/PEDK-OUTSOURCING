/**
 * SÓLO PARA SOPRINT. Lo normal es usar el GENERADOR (una página que se abre con doble
 * clic, la crea `npm run build`: build/Generador de codigos Vizo.html). Esto es la
 * versión de consola, y la cuenta independiente (con el `crypto` de Node) con la que
 * las pruebas comprueban la de la app.
 *
 *   node herramientas/codigo-pin-admin.mjs <SERIE> <SOLICITUD>
 *     p. ej.  node herramientas/codigo-pin-admin.mjs CV3DV0004X 482173
 *
 *   node herramientas/codigo-pin-admin.mjs --nueva-clave
 *     crea sign/rescate.key la PRIMERA vez (no pisa una que ya exista).
 *
 * La clave se lee de sign/rescate.key, o de la ruta en la variable VIZO_CLAVE_RESCATE.
 * Es la misma para todos los equipos: guárdela como una contraseña maestra y con copia.
 * Si se pierde, los equipos ya instalados no se pueden restablecer.
 *
 * Antes de dar el código, confirme quién llama (cliente, contrato, número de serie).
 */
import { createHmac, randomBytes } from 'crypto';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const raiz = join(dirname(fileURLToPath(import.meta.url)), '..');
const fichero = process.env.VIZO_CLAVE_RESCATE || join(raiz, 'sign', 'rescate.key');

/** La misma cuenta que src/codigoRescate.js: 4 primeros bytes del HMAC, módulo 10^6. */
export function codigo(clave, serie, solicitud) {
    const m = createHmac('sha256', Buffer.from(clave, 'latin1'))
        .update('vizo-pin-admin|' + String(serie).toUpperCase() + '|' + solicitud, 'latin1')
        .digest();
    return String(m.readUInt32BE(0) % 1000000).padStart(6, '0');
}

function leerClave() {
    if (!existsSync(fichero)) {
        console.error('No encuentro la clave en ' + fichero);
        process.exit(1);
    }
    return readFileSync(fichero, 'utf8').trim();
}

function principal(args) {
    if (args[0] === '--nueva-clave') {
        if (existsSync(fichero)) {
            console.error('Ya hay una clave en ' + fichero + ': no se pisa.');
            process.exit(1);
        }
        writeFileSync(fichero, randomBytes(32).toString('hex') + '\n');
        console.log('Clave creada en ' + fichero);
        console.log('GUÁRDELA AHORA en un sitio seguro (y con copia): sin ella no hay códigos.');
        return;
    }
    const serie = String(args[0] || '').trim().toUpperCase();
    const solicitud = String(args[1] || '').replace(/\D/g, '');
    if (!serie || solicitud.length !== 6) {
        console.error('Uso: node herramientas/codigo-pin-admin.mjs <SERIE> <SOLICITUD de 6 cifras>');
        process.exit(1);
    }
    const c = codigo(leerClave(), serie, solicitud);
    console.log('Serie ' + serie + ' · solicitud ' + solicitud);
    console.log('CÓDIGO: ' + c.slice(0, 3) + ' ' + c.slice(3));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
    principal(process.argv.slice(2));
}
