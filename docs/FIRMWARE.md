# Firmware del ESP32

El sketch [`Espower.ino`](../Firmware/Espower/Espower.ino) mide dos canales analógicos con EmonLib, acumula energía en memoria no volátil, muestra el estado en la OLED y sincroniza telemetría con Firebase Realtime Database. Esta guía describe el código incluido y cómo adaptarlo a la placa montada.

## Preparación y compilación

1. Instala Arduino IDE y el soporte **ESP32 by Espressif Systems**; selecciona la placa y el puerto serie correctos. Instala `EmonLib` de OpenEnergyMonitor, `Adafruit GFX Library`, `Adafruit SSD1306`, `WiFiManager` y `Firebase ESP Client` de Mobizt. `Wire`, `WiFi`, `Preferences` y `time` proceden del núcleo ESP32. El repositorio no incluye copias de esas bibliotecas.
2. Copia [`config.local.example.h`](../Firmware/Espower/config.local.example.h) a `Firmware/Espower/config.local.h`. Introduce la API key, URL completa de RTDB y correo/contraseña de una cuenta Firebase Authentication destinada al dispositivo. El archivo local está excluido de Git. La [guía de Firebase](FIREBASE.md) explica cada campo.
3. Verifica conexiones, aislamiento y amplitudes de las entradas ADC con la [guía del circuito](CIRCUITO.md). El CT confirmado es **100 A:50 mA** y la resistencia montada es **33 Ω**; a corrientes altas esta combinación puede recortar la señal.
4. Compila, carga el sketch y abre el monitor serie a **115200 baudios**. En el primer inicio, WiFiManager puede abrir `ESPOWER_Config` para introducir la red Wi-Fi. El portal caduca a los 180 s; si la conexión falla, el programa intenta reiniciar.

El código usa [Firebase-ESP-Client](https://github.com/mobizt/Firebase-ESP-Client). No hay versiones de dependencias bloqueadas en este repositorio: registra las versiones de Arduino IDE, núcleo ESP32 y bibliotecas usadas al reproducir la instalación.

## Arranque y rutas

`setup()` configura GPIO2 como indicador y GPIO0 como salida `IO` hacia R6 y MOC3061M según el esquema, inicia la OLED (`SDA=21`, `SCL=22`, dirección `0x3C`), registra EmonLib, recupera `kwh_total` de `Preferences` en el espacio `energy`, conecta Wi-Fi, sincroniza NTP y autentica en Firebase. Con el UID obtenido construye `/UsersData/{uid}`; después lee `/led` una vez.

La OLED alterna cada 4 s entre mediciones y estado de Wi-Fi/Firebase/NTP. Si no obtiene un UID durante 15 s, el ESP32 reinicia. Wi-Fi, NTP, Firebase y `calcVI` pueden bloquear; los intervalos de `loop()` son **nominales**, no garantías de tiempo real.

**GPIO0 es un pin de arranque del ESP32.** Si una etapa externa lo mantiene bajo durante el reset, el chip puede entrar en modo de descarga en lugar de ejecutar el programa. Su estado durante el arranque también puede producir una activación transitoria de la etapa; verifica el circuito físico, la resistencia de polarización y el comportamiento de la carga antes de usarlo como salida. Véase la [guía de modo de arranque de Espressif](https://docs.espressif.com/projects/esptool/en/latest/esp32/advanced-topics/boot-mode-selection.html). El sketch fija el estado bajo al iniciar y después sigue `/led`; esto no sustituye un enclavamiento físico seguro.

## Medición y fórmulas

GPIO34 y GPIO35 son entradas ADC1. El sketch configura 12 bits y atenuación de 11 dB. Usa `emon1.voltage(34, 234.26, 1.7)` y `emon1.current(35, 60.6)`. La segunda calibración corresponde teóricamente a `N/R = 2000/33 ≈ 60.6` para el CT y la carga confirmados. `emon1.calcVI(20, 2000)` toma cada muestra, con espera máxima configurada de 2000 ms.

```text
Vrms = raíz de la media de V² (EmonLib)
Irms = raíz de la media de I² (EmonLib)
P    = media de las muestras instantáneas V × I, en W
S    = Vrms × Irms, en VA
FP   = P / S si S > 1 VA; limitado a [-1, 1]
E_nueva(kWh) = E_anterior + P(W) × Δt(ms) / 3 600 000 000
```

El firmware muestra `FP=1` si `S≤1 VA`; con carga nula el factor de potencia físico no queda determinado. Si `Irms<0,05 A`, fuerza `I`, `P` y `S` a cero. Sólo suma energía para `P>0` y `Δt<60 000 ms`. La integración usa la **potencia de la muestra actual durante todo el intervalo**, no una integral trapezoidal. El contador se guarda en NVS cada 30 s; un reinicio puede perder la fracción desde el último guardado, y el equipo no restaura kWh desde RTDB.

Con 33 Ω a 100 A RMS, la señal ideal llega a `1,65 ± 2,333 V`, fuera del rango 0–3,3 V. Por tanto `60.6` corrige la relación nominal de conversión, **pero no corrige el recorte**; el rango lineal ideal termina alrededor de 70,7 A RMS y el rango útil real puede ser menor. `234.26` y `1.7` requieren calibración experimental. Consulta [cálculo y calibración](CIRCUITO.md#resistencia-de-carga-del-ct).

## Frecuencias y datos

| Operación | Intervalo nominal | Ruta o efecto |
| --- | ---: | --- |
| Adquirir V/I y acumular energía | 250 ms | Variables locales y OLED |
| Refrescar OLED | 500 ms | Pantalla I²C |
| Consultar `/led` | 300 ms | Salida GPIO0 e indicador GPIO2 |
| Enviar telemetría | 3000 ms | Cuatro `setFloat`: `telemetry/voltaje`, `corriente`, `potencia`, `kwh` |
| Crear datalog | 1 min | `datalog/YYYY-MM-DD/HH-MM`: V, I, P, kWh, FP y `timestamp` |
| Guardar kWh en NVS | 30 s | `energy/kwh_total` |
| Comprobar Wi-Fi | 10 s | Reconexión si procede |

El datalog requiere NTP. El sketch usa desplazamiento fijo **UTC−6** sin horario de verano para las claves de día/minuto; ajusta `GMT_OFFSET` si opera en otra zona. `timestamp` es Unix. El minuto se marca como registrado antes de escribir; un fallo de esa escritura no se reintenta dentro del mismo minuto. Las cuatro escrituras de telemetría son independientes, por lo que un lector puede recibir brevemente campos de ciclos distintos. Las rutas se detallan en [FIREBASE.md](FIREBASE.md#5-esquema-de-datos-usado-por-el-código).

## Control y límites del código incluido

La web guarda `led`, `led1`, `led2` y `led3`. El firmware **sólo lee `led`**. Interpreta entero `1` o cadenas `1`, `ON`, `TRUE` como activado y lleva GPIO0 y GPIO2 a `HIGH`; el esquema conecta `IO` por R6 al LED del optotriac. Comprueba en el equipo real que ese nivel efectivamente encienda y apague la carga. No hay control de `led1` a `led3`, ni lectura de `commands/restart` o de los ajustes `configure/ccalibrate`, `vcalibrate`, `wmeter`, `dataloggerMinutes` desde el firmware. Calibración e intervalo del firmware se modifican en el sketch.

Los horarios y automatizaciones de la web se evalúan en JavaScript mientras hay una página autenticada abierta. La [arquitectura](ARQUITECTURA.md) distingue qué funciones operan sin navegador.

## Diagnóstico

| Síntoma | Revisar |
| --- | --- |
| Entra en modo de descarga o no arranca | Nivel de GPIO0 durante reset y carga conectada al pin |
| Reinicia al autenticar | Wi-Fi, cuenta Auth, URL y reglas RTDB, respuesta UID |
| `permission_denied` | UID autenticado, ruta `UsersData/{uid}` y reglas |
| No se genera datalog | NTP y conectividad; el minuto fallido no se reintenta |
| I/P erróneas a corriente alta | Recorte por 33 Ω, amplitud ADC, calibración y sentido del CT |
| OLED vacía | 3,3 V, SDA/SCL, dirección `0x3C` y bibliotecas |

La zona conectada a red debe inspeccionarse con sus protecciones y aislamiento antes de energizarse. El estado mostrado en la web no certifica la seguridad del accionamiento.
