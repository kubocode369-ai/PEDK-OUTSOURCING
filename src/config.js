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
    /** Nombre y apellidos de la persona, para saber quién es cada usuario. */
    NOMBRE_COMPLETO_MAX: 60,

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

    /**
     * RESPALDO POR RED. El equipo no puede leer ni escribir en una flash USB (sólo
     * enciende y apaga el puerto: medido el 17-09-2026), así que la única salida y
     * entrada de datos es HTTP contra un PC de la misma red. Ver herramientas/
     * respaldo-servidor.py, que atiende las dos rutas.
     *
     * Sólo se teclea la IP en el panel: el puerto y las rutas son fijos, porque el
     * teclado de texto no tiene ':' ni '/'.
     */
    RESPALDO_PUERTO: 8099,
    /** Donde se manda el respaldo completo (POST con el JSON). */
    RESPALDO_RUTA_SUBIR: '/respaldo',
    /** Gente NUEVA a dar de alta en bloque: la lista que escribe el administrador. */
    RESPALDO_RUTA_USUARIOS: '/usuarios.json',
    /**
     * El ÚLTIMO respaldo, para devolver el equipo a como estaba. Va por una ruta
     * distinta a propósito: restaurar y dar de alta gente nueva son cosas distintas, y
     * mezclarlas en un solo botón hizo que una plantilla de ejemplo se diera de alta
     * como si fueran usuarios de verdad.
     */
    RESPALDO_RUTA_RESTAURAR: '/restaurar.json',
    /** Cada cuánto se intenta el respaldo automático, si hay algo nuevo que guardar. */
    RESPALDO_AUTO_MS: 30 * 60 * 1000,
    /** Margen tras arrancar antes del primer respaldo: que la red esté lista. */
    RESPALDO_ESPERA_INICIAL_MS: 60 * 1000,

    /**
     * PANEL WEB en la propia impresora: http://<ip>/pedk/app_notify/<WEB_APP>.
     * Tiene que ser el `name` del package.json: el firmware enruta por él (medido el
     * 21-09-2026; con otro nombre contesta "app name is not find!!!").
     */
    WEB_APP: 'impresion-pin-BM5220ADW',
    /** Minutos sin usar la web tras los que hay que volver a poner el PIN. */
    WEB_SESION_MS: 15 * 60 * 1000,
    /**
     * Tope de cada respuesta web, en bytes. Medido el 21-09-2026 con /tam?n=...: hasta
     * 1998 bytes salen; desde 1999 la impresora anuncia la respuesta y no manda nada
     * (página en blanco). Con 4390 además dejó la web colgada hasta reiniciar. Se deja
     * margen por si el firmware cuenta algo más que el cuerpo.
     */
    WEB_MAX_BYTES: 1800,
};
