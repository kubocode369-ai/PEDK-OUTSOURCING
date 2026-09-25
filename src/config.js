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
    /**
     * CUÁNTOS USUARIOS. Medido el 21-09-2026 (Ajustes > Capacidad, dos veces): cada
     * trabajo contado reescribe todos los datos, y eso tarda ~0,85 s por cada 1000
     * usuarios (500 -> 0,44 s; 1000 -> 0,85 s; 3000 -> 2,4 s). Mientras dura, el panel
     * y el guardián están parados. El espacio NO es el límite: 3000 cupieron.
     * A partir de AVISO se avisa en la web; en MAX ya no se deja crear más.
     */
    USUARIOS_AVISO: 500,
    USUARIOS_MAX: 1000,

    /** Nombre y apellidos de la persona, para saber quién es cada usuario. */
    NOMBRE_COMPLETO_MAX: 60,
    /** Correo de la persona, para mandarle lo que escanea. */
    CORREO_MAX: 60,

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

    /**
     * Tras salir al menú de la impresora ("Ir a copiar") la app no se dibuja hasta que
     * la persona vuelva. Si el equipo no avisara nunca de la vuelta, pasado este tiempo
     * y SIN sesión abierta se recupera el panel (con sesión nunca: le quitaría la copia).
     */
    FUERA_MAX_MS: 2 * 60 * 1000,

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
     * PANEL WEB en la propia impresora: http://<ip>/pedk/app_notify/<WEB_APP>.
     * Tiene que ser el `name` del package.json: el firmware enruta por él (medido el
     * 21-09-2026; con otro nombre contesta "app name is not find!!!"). El prefijo
     * /pedk/app_notify/ lo pone el firmware y no se puede cambiar. Era
     * 'impresion-pin-BM5220ADW'; se acortó para que la dirección sea fácil de dar.
     */
    WEB_APP: 'vizo',
    /** Minutos sin usar la web tras los que hay que volver a poner el PIN. */
    WEB_SESION_MS: 15 * 60 * 1000,
    /**
     * Tope de cada respuesta web, en bytes. Medido el 21-09-2026 con /tam?n=...: hasta
     * 1998 bytes salen (con Content-Type text/plain); desde 1999 la impresora anuncia
     * la respuesta y no manda nada (página en blanco). Con 4390 además dejó la web
     * colgada hasta reiniciar. 1900 deja margen aunque el firmware contara también la
     * cabecera (text/html es 14 bytes más largo que text/plain).
     */
    WEB_MAX_BYTES: 1900,
    /**
     * Lo que la impresora RECIBE aguanta mucho menos (medido el 21-09-2026): un POST de
     * 502 bytes llega y uno de 1002 cuelga la web hasta reiniciar. La copia de
     * seguridad se sube en trozos de estos caracteres (más ~50 del resto del envío).
     */
    WEB_TROZO_SUBIDA: 240,
    /**
     * 2000 trozos = ~360 KB: una copia de 1000 usuarios SIN comprimir (~280 KB) cabe.
     * Comprimida (lo normal) son ~160 trozos.
     */
    WEB_SUBIDA_MAX_TROZOS: 2000,
};
