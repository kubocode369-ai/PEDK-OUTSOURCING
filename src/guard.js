/**
 * Protección de los callbacks que invoca el FIRMWARE (botones, temporizadores,
 * listeners). Si uno lanza, la excepción llega al código nativo y puede dejar el
 * panel colgado hasta reiniciar el equipo. Regla: todo callback pasa por guard().
 */
export function guard(nombre, fn) {
    return function (...args) {
        try {
            const out = fn.apply(this, args);
            if (out && typeof out.then === 'function') {
                return out.catch((e) => {
                    anotar(nombre, e);
                    return null;
                });
            }
            return out;
        } catch (e) {
            anotar(nombre, e);
            return null;
        }
    };
}

function anotar(nombre, e) {
    console.log('[guard] error en ' + nombre + ' -> ' + String((e && e.message) || e).slice(0, 120));
}
