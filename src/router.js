/**
 * Pantalla activa y repintado. Cada pantalla es una función que devuelve la lista
 * de widgets; el router la recuerda para redibujarla cuando el firmware nos quita
 * el panel (reposo, vuelta al frente) y para que los módulos cambien de pantalla
 * sin importarse entre ellos.
 */
let dibujar = null;
let actual = null;
let nombreActual = null;

/*
 * FUERA DE LA APP: cuando la persona sale al menú de la impresora (p. ej. "Ir a copiar"),
 * no se dibuja NADA hasta que vuelva. En este equipo dibujar trae la app al frente, y
 * el repintado periódico, el reloj de la sesión o contar la copia recién hecha la
 * arrancaban de la pantalla de copia a los pocos segundos (visto el 22-09-2026). Se
 * sigue llevando la cuenta de qué pantalla toca, y se dibuja al volver.
 */
let fuera = false;
let fueraDesde = 0;

export function salioDeLaApp() {
    fuera = true;
    fueraDesde = Date.now();
}

export function volvioALaApp() {
    fuera = false;
}

/** Milisegundos que lleva fuera, o -1 si está dentro. */
export function tiempoFuera() {
    return fuera ? Date.now() - fueraDesde : -1;
}

export function conectarDibujo(fn) {
    dibujar = fn;
}

export function mostrar(nombre, render) {
    nombreActual = nombre;
    actual = render;
    repintar();
}

export function repintar() {
    if (!actual || !dibujar || fuera) {
        return false;
    }
    try {
        dibujar(actual());
        return true;
    } catch (e) {
        console.log('[router] error al dibujar ' + nombreActual + ' -> ' + (e && e.message));
        return false;
    }
}

export function pantallaActiva() {
    return nombreActual;
}
