/**
 * Reposo del equipo. Al despertar hay que volver a dibujar: si no, el panel queda
 * con la imagen anterior y los botones no responden. Y dibujar DURANTE el reposo
 * deja el panel bloqueado. Estados: 0 = despierto, 1 = reposo.
 */
import { guard } from './guard.js';

function ns() {
    return (globalThis.pedk && pedk.device && pedk.device.powersave) || null;
}

/** 0 despierto, 1 reposo, null si no se puede leer. */
export function estadoEnergia() {
    const p = ns();
    if (!p || typeof p.getCurrentState !== 'function') {
        return null;
    }
    try {
        const v = p.getCurrentState();
        const n = typeof v === 'number' ? v : parseInt(v, 10);
        return Number.isNaN(n) ? null : n;
    } catch (e) {
        return null;
    }
}

export function enReposo() {
    return estadoEnergia() === 1;
}

/** Llama a `alDespertar` cada vez que el equipo sale del reposo. */
export function escucharDespertar(alDespertar) {
    const p = ns();
    if (!p || typeof p.LowPowerStateChangeListener !== 'function' || typeof p.addListener !== 'function') {
        return false;
    }
    try {
        const listener = new p.LowPowerStateChangeListener();
        listener.notify = guard('energia', function (estado) {
            const n = typeof estado === 'number' ? estado : parseInt(estado, 10);
            if (n === 0) {
                alDespertar();
            }
        });
        p.addListener(listener);
        return true;
    } catch (e) {
        console.log('[energia] no se pudo escuchar: ' + (e && e.message));
        return false;
    }
}
