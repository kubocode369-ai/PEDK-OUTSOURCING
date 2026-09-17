/**
 * Ajustes fijos de la app. Lo que el administrador cambia desde el panel vive en
 * store.js (memoria del equipo), no aquí.
 */
export const config = {
    /**
     * PIN de administrador de fábrica. Deja de valer en cuanto se cambia desde el
     * panel. Ojo: reinstalar la app borra la memoria y lo vuelve a poner.
     */
    PIN_ADMIN_FABRICA: '2580',

    /** Largo mínimo y máximo de los PIN (de persona y de administrador). */
    PIN_MIN: 4,
    PIN_MAX: 8,

    /** Nombre de usuario: minúsculas, dígitos y . _ - */
    USUARIO_MAX: 20,

    /** Intentos fallidos seguidos antes de bloquear a ese usuario un rato. */
    INTENTOS_MAX: 5,
    BLOQUEO_INTENTOS_MS: 5 * 60 * 1000,

    /** Minutos sin actividad que dura una sesión, a elegir en Ajustes. */
    MINUTOS_SESION_OPCIONES: [2, 3, 5, 10],
    MINUTOS_SESION_DEFECTO: 3,

    /**
     * Tras cerrar la sesión, los trabajos que aparezcan en el historial durante este
     * tiempo se siguen cargando a esa persona: el documento pudo mandarse justo antes
     * de pulsar "Terminar" y terminar de salir después.
     */
    GRACIA_MS: 90 * 1000,

    /**
     * Cada cuánto se lee el historial del equipo. Más seguido con una sesión abierta.
     * No bajar de unos segundos: sondear el equipo en bucle degradó el táctil en el
     * agente de CloudPrint (con getJobList; el historial cada 8 s sí fue estable).
     */
    HISTORIAL_CON_SESION_MS: 6000,
    HISTORIAL_SIN_SESION_MS: 30000,

    /** Repintado para recuperar el panel (reposo, vuelta al frente). */
    REPINTADO_MS: 8000,
    REPINTADO_HUECO_MIN_MS: 5000,
    REPINTADO_TRAS_DESPERTAR_MS: 2000,

    /** Tras liberar un documento retenido, espera antes de volver a pedir la lista. */
    RETENCION_RELEER_MS: 5000,


    /** Duración del modo "probar cerradura" del diagnóstico. */
    PRUEBA_CERRADURA_MS: 2 * 60 * 1000,

    FILAS_POR_PAGINA: 4,
    REGISTRO_MAX: 60,
    VISTOS_MAX: 200,
};
