# Conectar ESPower con Firebase

La web usa el SDK modular de Firebase 10.12.5 cargado desde CDN. El ESP32 usa `Firebase_ESP_Client.h`. Ambos clientes se autentican con Firebase Authentication y leen o escriben **Realtime Database (RTDB)** bajo `UsersData/{uid}`. Este documento permite configurar otra instalación sin publicar la configuración concreta de una cuenta.

## 1. Preparar el proyecto

1. En [Firebase Console](https://console.firebase.google.com/), crea o selecciona el proyecto.
2. En **Authentication → Sign-in method**, activa **Correo electrónico/contraseña**. Crea la cuenta que utilizará el equipo; conserva su contraseña fuera del repositorio. Si la web entra con una cuenta distinta, sus datos quedarán en otro UID con las reglas simples de esta guía.
3. En **Realtime Database**, crea una base y anota su URL completa desde la consola. La forma depende de la región (`...firebaseio.com` o `...firebasedatabase.app`); no la deduzcas a partir del ID del proyecto.
4. En **Configuración del proyecto → Tus apps**, registra una aplicación web si no existe y copia sus campos de configuración. El objeto de configuración identifica el proyecto, pero las reglas de RTDB son las que autorizan el acceso. Por la política de publicación de este repositorio, tampoco se incluye aquí el valor de `apiKey`.

Firebase documenta la [creación de RTDB y su URL](https://firebase.google.com/docs/database/web/start), la [habilitación de correo/contraseña](https://firebase.google.com/docs/auth/web/password-auth) y el [modelo de reglas](https://firebase.google.com/docs/database/security).

## 2. Configurar la web sin subir la API key

En `js/`, copia `firebase-config.example.js` como `firebase-config.local.js`. Completa los campos que muestra la consola (`apiKey`, `authDomain`, `projectId`, `databaseURL`, `appId` y los adicionales que requiera tu app). `js/firebase-config.js` importa ese archivo local y crea `auth` y `db`. El archivo `.local.js` se excluye con `.gitignore`; compruébalo con `git check-ignore js/firebase-config.local.js` antes de cualquier commit.

La configuración web se entrega al navegador para que el SDK conecte con Firebase. **No pongas una cuenta de servicio ni una contraseña de usuario en JavaScript.** Aunque el identificador `apiKey` de una app web no sustituye a un secreto de servidor, la protección de datos depende de Authentication, reglas y restricciones apropiadas del proyecto.

## 3. Configurar el firmware sin subir credenciales

En `Firmware/Espower/`, copia `config.local.example.h` como `config.local.h` y completa:

| Macro | Origen |
| --- | --- |
| `API_KEY` | Configuración de la aplicación Firebase |
| `DATABASE_URL` | URL completa de Realtime Database |
| `USER_EMAIL` | Cuenta Authentication dedicada al dispositivo |
| `USER_PASSWORD` | Contraseña de esa cuenta, guardada sólo localmente |

El sketch asigna estos valores a `FirebaseConfig` y `FirebaseAuth`. Tras autenticar, toma `auth.token.uid` y construye las rutas `UsersData/{uid}/...`. Si el usuario de la web tiene otro UID, no verá esa rama salvo que diseñes reglas y una asociación explícita entre usuario y dispositivo. El sketch actual no implementa esa asociación. `config.local.h` queda excluido de Git; verifica con `git check-ignore Firmware/Espower/config.local.h`.

No publiques capturas de la consola que muestren contraseñas, tokens de sesión o reglas temporales abiertas. Si una credencial se expuso antes, cámbiala en Firebase Authentication y actualiza sólo los archivos locales.

## 4. Reglas de acceso

Para una instalación **de una cuenta/UID**, el siguiente ejemplo restringe lectura y escritura a esa misma cuenta. Revísalo en el simulador de reglas de Firebase antes de aplicarlo y adapta la estructura si web y dispositivo tienen identidades distintas:

```json
{
  "rules": {
    "UsersData": {
      "$uid": {
        ".read": "auth != null && auth.uid === $uid",
        ".write": "auth != null && auth.uid === $uid"
      }
    }
  }
}
```

Este ejemplo concede escritura a **toda** la rama del propio UID porque la web permite configurar, cambiar salidas y borrar sus datos. Para varios operadores, dispositivos independientes o separación entre lectura y control, define permisos por rol/ruta y reglas `.validate`; no abras `UsersData` globalmente. Firebase explica la [herencia de reglas y la variable `auth.uid`](https://firebase.google.com/docs/database/security/rules-conditions).

## 5. Esquema de datos usado por el código

```text
UsersData/{uid}/
  telemetry/
    voltaje       número, V RMS
    corriente     número, A RMS
    potencia      número, W reales
    kwh           número, energía acumulada
  datalog/YYYY-MM-DD/HH-MM
    { voltaje, corriente, potencia, kwh, fp, timestamp }
  led             0/1 o cadena compatible con el firmware
  led1, led2, led3
  monthStart/YYYY-MM   lectura acumulada al inicio observado del mes
  monthly/YYYY-MM      consumo mensual calculado por la web
  configure/           tarifa, límites y preferencias de la web
  deviceNames/, deviceIcons/, deviceHistory/
  schedules/, automations/
  commands/restart     orden escrita por la web; no consumida por este sketch
```

`js/firebase-paths.js` centraliza las rutas web. El firmware escribe cuatro `setFloat` individuales bajo `telemetry` cada 3 s nominales y un JSON en `datalog` cada 1 min nominal. La web usa `onValue` para leer, actualiza `monthly` a partir de `kwh` y puede escribir registros `datalog` según `displayIntervalMs`. Por ello un mismo `HH-MM` puede recibir una escritura del ESP32 y otra del navegador; la última escritura en esa ruta prevalece. El valor mensual se materializa cuando la web está abierta y autenticada: no hay un proceso servidor que lo calcule por sí solo.

La web escribe `led` a `led3`; **este firmware sólo lee `led`** y lo aplica a GPIO0 (salida del optotriac en el esquema) y GPIO2 (indicador). Las otras tres rutas no tienen actuador en el sketch. También hay acciones de configuración y reinicio en la web sin consumidor en el firmware. Consulta la [matriz de alcance](ARQUITECTURA.md#alcance-comprobado-en-el-código) y la advertencia sobre [GPIO0 al arrancar](FIRMWARE.md#arranque-y-rutas).

## 6. Verificación paso a paso

1. Compila y carga el sketch con sus valores locales. En el monitor serie a **115200 baudios**, confirma conexión Wi-Fi, NTP y autenticación Firebase. No publiques el log completo: puede contener UID, IP o datos operativos.
2. En la consola RTDB, comprueba que `UsersData/{uid}/telemetry/{voltaje,corriente,potencia,kwh}` recibe números; comprueba luego `datalog/YYYY-MM-DD/HH-MM`.
3. Sirve la web por HTTP/HTTPS, inicia sesión con el usuario del mismo UID y verifica el panel principal, el datalogger y los gráficos.
4. Cambia `led` desde la web y comprueba las señales de **GPIO0** y del indicador **GPIO2** con la etapa de red aislada y sin energizar. El registro serial confirma la ruta de software; el comportamiento de la carga debe validarse por separado y con el circuito protegido.
5. Verifica que otra cuenta no pueda leer ni escribir el UID anterior. Prueba lectura, escritura y borrado previstos con el simulador de reglas de Firebase.

Si la web muestra `permission_denied`, compara el UID de ambas sesiones y las reglas publicadas. Si no aparece telemetría, comprueba URL RTDB, NTP, Wi-Fi, autenticación y las rutas exactas. Si el navegador no carga los módulos, confirma que `firebase-config.local.js` existe **en el despliegue** y que el sitio se sirve por HTTP/HTTPS.

## Despliegue de archivos estáticos

Para Firebase Hosting o cualquier hosting estático, prepara un directorio de publicación que contenga `index.html`, `404.html`, `html/`, `css/`, `js/` y `assets/`, incluido el `js/firebase-config.local.js` de esa instalación. No copies `Firmware/`, `docs/`, `.git/` ni archivos de credenciales del ESP32 al hosting. El archivo de configuración web será accesible para los visitantes por diseño; **no incluyas en él contraseñas, tokens ni claves privadas**. Revisa las reglas RTDB antes de hacer público el sitio.
