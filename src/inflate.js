/**
 * Descompresor DEFLATE (RFC 1951, "deflate-raw"), para las copias que sube el
 * navegador comprimidas con CompressionStream. El motor de la impresora no trae zlib
 * ni DecompressionStream, así que va aquí. Sigue el diseño de tiny-inflate (Joergen
 * Ibsen / Devon Govett, licencia MIT): tablas de Huffman canónicas y lectura bit a bit.
 *
 * inflar(Uint8Array | number[]) -> number[] (bytes). Lanza si los datos no son deflate.
 */

function Arbol() {
    this.cuenta = new Array(16).fill(0);   // cuántos códigos hay de cada longitud
    this.simbolos = new Array(288).fill(0);
}

// Tablas fijas de longitudes y distancias (RFC 1951, 3.2.5).
const BASE_LONG = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59,
    67, 83, 99, 115, 131, 163, 195, 227, 258];
const EXTRA_LONG = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const BASE_DIST = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769,
    1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const EXTRA_DIST = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
// Orden en que llegan las longitudes del árbol de longitudes en los bloques dinámicos.
const ORDEN_CL = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

/** Construye un árbol canónico a partir de las longitudes de código de cada símbolo. */
function construir(arbol, longitudes, desde, n) {
    arbol.cuenta.fill(0);
    for (let i = 0; i < n; i++) arbol.cuenta[longitudes[desde + i]]++;
    arbol.cuenta[0] = 0;
    const offs = new Array(16);
    let suma = 0;
    for (let i = 0; i < 16; i++) {
        offs[i] = suma;
        suma += arbol.cuenta[i];
    }
    for (let i = 0; i < n; i++) {
        const l = longitudes[desde + i];
        if (l) arbol.simbolos[offs[l]++] = i;
    }
}

function arbolesFijos() {
    const lt = new Arbol();
    const dt = new Arbol();
    const l = new Array(288);
    for (let i = 0; i < 144; i++) l[i] = 8;
    for (let i = 144; i < 256; i++) l[i] = 9;
    for (let i = 256; i < 280; i++) l[i] = 7;
    for (let i = 280; i < 288; i++) l[i] = 8;
    construir(lt, l, 0, 288);
    construir(dt, new Array(30).fill(5), 0, 30);
    return { lt, dt };
}

export function inflar(entrada) {
    const src = entrada;
    let pos = 0;
    let bits = 0;
    let nbits = 0;
    const out = [];

    function bit() {
        if (nbits === 0) {
            if (pos >= src.length) throw new Error('datos comprimidos cortados');
            bits = src[pos++];
            nbits = 8;
        }
        const b = bits & 1;
        bits >>>= 1;
        nbits--;
        return b;
    }
    function leer(n, base) {
        let v = 0;
        for (let i = 0; i < n; i++) v |= bit() << i;
        return v + (base || 0);
    }
    function simbolo(arbol) {
        let suma = 0;
        let cur = 0;
        let len = 0;
        do {
            cur = 2 * cur + bit();
            len++;
            if (len > 15) throw new Error('código Huffman no válido');
            suma += arbol.cuenta[len];
            cur -= arbol.cuenta[len];
        } while (cur >= 0);
        return arbol.simbolos[suma + cur];
    }
    function dinamicos() {
        const hlit = leer(5, 257);
        const hdist = leer(5, 1);
        const hclen = leer(4, 4);
        const longs = new Array(288 + 32).fill(0);
        for (let i = 0; i < hclen; i++) longs[ORDEN_CL[i]] = leer(3);
        const cl = new Arbol();
        construir(cl, longs, 0, 19);
        longs.fill(0);
        let n = 0;
        while (n < hlit + hdist) {
            const s = simbolo(cl);
            if (s < 16) {
                longs[n++] = s;
            } else {
                let rep;
                let val = 0;
                if (s === 16) {
                    if (n === 0) throw new Error('repetición sin valor previo');
                    val = longs[n - 1];
                    rep = leer(2, 3);
                } else if (s === 17) {
                    rep = leer(3, 3);
                } else {
                    rep = leer(7, 11);
                }
                while (rep--) longs[n++] = val;
            }
        }
        const lt = new Arbol();
        const dt = new Arbol();
        construir(lt, longs, 0, hlit);
        construir(dt, longs, hlit, hdist);
        return { lt, dt };
    }
    function bloque(arboles) {
        for (;;) {
            const s = simbolo(arboles.lt);
            if (s === 256) return;
            if (s < 256) {
                out.push(s);
                continue;
            }
            const i = s - 257;
            if (i >= 29) throw new Error('longitud no válida');
            const largo = leer(EXTRA_LONG[i], BASE_LONG[i]);
            const d = simbolo(arboles.dt);
            if (d >= 30) throw new Error('distancia no válida');
            const dist = leer(EXTRA_DIST[d], BASE_DIST[d]);
            if (dist > out.length) throw new Error('distancia fuera de rango');
            const desde = out.length - dist;
            for (let k = 0; k < largo; k++) out.push(out[desde + k]);
        }
    }
    function guardado() {
        // Bloque sin comprimir: se descartan los bits que queden del byte actual.
        nbits = 0;
        if (pos + 4 > src.length) throw new Error('datos comprimidos cortados');
        const len = src[pos] | (src[pos + 1] << 8);
        const nlen = src[pos + 2] | (src[pos + 3] << 8);
        if ((len ^ 0xffff) !== nlen) throw new Error('bloque sin comprimir dañado');
        pos += 4;
        if (pos + len > src.length) throw new Error('datos comprimidos cortados');
        for (let i = 0; i < len; i++) out.push(src[pos++]);
    }

    let fijos = null;
    let ultimo;
    do {
        ultimo = bit();
        const tipo = leer(2);
        if (tipo === 0) guardado();
        else if (tipo === 1) bloque(fijos || (fijos = arbolesFijos()));
        else if (tipo === 2) bloque(dinamicos());
        else throw new Error('tipo de bloque no válido');
    } while (!ultimo);
    return out;
}
