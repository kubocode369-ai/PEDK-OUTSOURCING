/**
 * Pantalla activa y repintado. Cada pantalla es una función que devuelve la lista
 * de widgets; el router la recuerda para redibujarla cuando el firmware nos quita
 * el panel (reposo, vuelta al frente) y para que los módulos cambien de pantalla
 * sin importarse entre ellos.
 */
let dibujar = null;
let actual = null;
let nombreActual = null;

export function conectarDibujo(fn) {
    dibujar = fn;
}

export function mostrar(nombre, render) {
    nombreActual = nombre;
    actual = render;
    repintar();
}

export function repintar() {
    if (!actual || !dibujar) {
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
