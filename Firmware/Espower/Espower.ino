/*
 * ============================================================================
 *  ESPower Monitor — Sistema de Monitoreo de Energía en Tiempo Real
 * ============================================================================
 *
 *  Plataforma  : ESP32 (Arduino Framework)
 *  Sensores    : SCT-013-100A (corriente), ZMPT101B (voltaje)
 *  Pantalla    : OLED SSD1306 0.96" (I2C)
 *  Backend     : Firebase Realtime Database
 *  Conectividad: WiFi (WiFiManager) + NTP
 *
 *  Funcionalidades:
 *    - Medición de V, I, P (real), factor de potencia
 *    - Cálculo de energía acumulada (kWh) con persistencia en NVS
 *    - Detección de cruce por cero y cálculo de desfase V/I
 *    - Envío de telemetría a Firebase RTDB
 *    - Datalogger con timestamp NTP
 *    - Pantalla OLED con estado de conexión
 *    - Lectura de /led: salida optotriac GPIO0 e indicador GPIO2
 *    - Planificación por millis (la adquisición y la red pueden bloquear)
 *
 *  Autor       : ESPower Team
 * ============================================================================
 */

// Desactivar logs internos de Firebase para liberar RAM/CPU
#define FIREBASE_DISABLE_ALL_LOG

// ======================== LIBRERÍAS =========================================
#include "EmonLib.h"              // Medición de energía (Vrms, Irms, potencia real)
#include <Wire.h>                 // Bus I2C
#include <Adafruit_GFX.h>         // Gráficos OLED
#include <Adafruit_SSD1306.h>     // Driver OLED SSD1306
#include <WiFi.h>                 // WiFi ESP32
#include <WiFiManager.h>          // Portal cautivo para config WiFi
#include <Firebase_ESP_Client.h>  // Cliente Firebase
#include <Preferences.h>          // NVS — almacenamiento persistente
#include <time.h>                 // NTP / manejo de tiempo

// Helpers de Firebase
#include "addons/TokenHelper.h"
#include "addons/RTDBHelper.h"

// ======================== CONFIGURACIÓN FIREBASE ============================
// Copia config.local.example.h como config.local.h y complétalo sólo en local.
#include "config.local.h"

// ======================== CONFIGURACIÓN DE SENSORES =========================
// --- Pines analógicos (ADC1 — WiFi-safe) ---
#define PIN_VOLTAJE    34   // ZMPT101B → GPIO34
#define PIN_CORRIENTE  35   // SCT-013-100A → GPIO35

// --- Constantes de calibración ---
// ZMPT101B: ajustar según la relación de transformación y el divisor resistivo.
// Procedimiento:  medir con un multímetro verdadero RMS el voltaje de la línea
//                 y ajustar CONSTANTE_V hasta que coincida.
#define CONSTANTE_V    234.26

// SCT-013 (100 A : 50 mA), carga montada de 33 Ω.
// Calibración teórica de EmonLib: 2000 / 33 = 60.606...
// A 100 A la señal excede 0–3.3 V; revisar el rango y calibrar con referencia.
#define CONSTANTE_I    60.6

// Coeficiente de compensación de fase de EmonLib entre señales.
// Compensa el desfase físico del ZMPT101B.  Ajustar hasta que la potencia
// reactiva sea ≈ 0 con carga puramente resistiva (foco incandescente).
#define FASE           1.7

// Umbral de ruido de corriente (A).  Por debajo se considera 0.
#define UMBRAL_CORRIENTE  0.05f

// ======================== CONFIGURACIÓN OLED ================================
#define SCREEN_WIDTH   128
#define SCREEN_HEIGHT  64
#define OLED_RESET     -1
#define SCREEN_ADDRESS 0x3C

// ======================== CONFIGURACIÓN NTP =================================
static const char* NTP_SERVER_1 = "pool.ntp.org";
static const char* NTP_SERVER_2 = "time.nist.gov";
static const long  GMT_OFFSET   = -6 * 3600;   // UTC-6; ajustar a la zona local
static const int   DST_OFFSET   = 0;            // Sin horario de verano

// ======================== INTERVALOS (millis) ================================
// Intervalo del datalog del firmware (configurable en minutos).
// La telemetría usa FIREBASE_SEND_INTERVAL_MS por separado.
static const unsigned long DATALOG_INTERVAL_MINUTES = 1;

// Intervalos internos — en milisegundos
static const unsigned long SENSOR_INTERVAL_MS        = 250;     // Lectura sensores
static const unsigned long DISPLAY_INTERVAL_MS       = 500;     // Refresco OLED
static const unsigned long FIREBASE_SEND_INTERVAL_MS = 3000;    // Telemetría RTDB
static const unsigned long FIREBASE_POLL_INTERVAL_MS = 300;     // Leer /led
static const unsigned long PREFS_SAVE_INTERVAL_MS    = 30000;   // kWh → flash
static const unsigned long WIFI_CHECK_INTERVAL_MS    = 10000;   // Revisar WiFi

// ======================== PINES AUXILIARES ===================================
static const int PIN_LED_LOCAL = 2;  // Indicador integrado en el ESP32
static const int PIN_RELE = 0;       // Red IO → R6 → MOC3061M del esquema

// ======================== OBJETOS GLOBALES ==================================
// Firebase
FirebaseData   fbdo;
FirebaseAuth   auth;
FirebaseConfig config;

// Emon
EnergyMonitor emon1;

// OLED
Adafruit_SSD1306 oled(SCREEN_WIDTH, SCREEN_HEIGHT, &Wire, OLED_RESET);

// Preferences (NVS)
Preferences preferences;

// ======================== VARIABLES DE ESTADO ==============================

// --- Rutas Firebase ---
String uid;
String databasePath;
String telemetryPath;
String voltajePath, corrientePath, potPath, kwhPath;
String ledPath;
String datalogPathPrefix;

// --- Mediciones ---
float voltage       = 0.0f;
float current       = 0.0f;
float power         = 0.0f;    // Potencia real (W)
float apparentPower = 0.0f;    // Potencia aparente (VA)
float powerFactor   = 0.0f;    // Factor de potencia (cos φ)
float kWh           = 0.0f;    // Energía acumulada

// --- Energía ---
unsigned long lastEnergyMillis = 0;

// --- Temporización por millis() ---
unsigned long lastSensorMillis       = 0;
unsigned long lastDisplayMillis      = 0;
unsigned long lastFirebaseSendMillis = 0;
unsigned long lastFirebasePollMillis = 0;
unsigned long lastDatalogMillis      = 0;
unsigned long lastPrefsSaveMillis    = 0;
unsigned long lastWiFiCheckMillis    = 0;

// --- Datalog ---
String lastLoggedMinute = "";

// --- LED / relé remoto ---
bool firebaseRelayState = false;
bool lastRelayState     = false;

// --- Estado de conexión ---
bool oledInitialized = false;
bool firebaseReady   = false;
bool ntpSynced       = false;

// --- Página de OLED (rotativo) ---
uint8_t oledPage         = 0;   // 0 = mediciones, 1 = estado
unsigned long lastPageSwitch = 0;
static const unsigned long PAGE_SWITCH_MS = 4000;

// ============================================================================
//                           FUNCIONES AUXILIARES
// ============================================================================

/**
 * @brief Obtiene la hora Unix actual vía NTP.
 * @return Epoch time (segundos desde 1/1/1970) o 0 si no hay sincronización.
 */
unsigned long getTime() {
  time_t now;
  struct tm timeinfo;
  if (!getLocalTime(&timeinfo, 100)) {
    ntpSynced = false;
    return 0;
  }
  ntpSynced = true;
  time(&now);
  return (unsigned long)now;
}

/**
 * @brief Obtiene fecha/hora formateada para el serial.
 */
String getFormattedTime() {
  struct tm timeinfo;
  if (!getLocalTime(&timeinfo, 100)) return "NTP no disponible";
  char buf[32];
  strftime(buf, sizeof(buf), "%Y-%m-%d %H:%M:%S", &timeinfo);
  return String(buf);
}

// ============================================================================
//                            LECTURA DE SENSORES
// ============================================================================

/**
 * @brief Lee voltaje, corriente, y calcula potencia real con EmonLib.
 *
 * EmonLib.calcVI() internamente:
 *   1. Muestrea N semiondas completas (detecta cruce por cero).
 *   2. Calcula Vrms e Irms con media cuadrática.
 *   3. Calcula la potencia real (P) como promedio del producto instantáneo V·I.
 *   4. De ahí se deriva el factor de potencia: FP = P / (Vrms × Irms).
 *
 * Los parámetros son:
 *   - crossings   : Nº de cruces por cero a esperar (≈ semiondas). Más = más preciso pero más lento.
 *   - timeout_ms  : Tiempo máximo de espera.
 *
 * Para 60 Hz, un ciclo completo = 16.67 ms.  Con 20 crossings ≈ 10 ciclos ≈ 167 ms.
 * Con 10 crossings ≈ 5 ciclos ≈ 83 ms  (buen balance velocidad/precisión).
 */
void readSensors() {
  // --- Medición con detección de cruce por cero ---
  // 20 crossings = ~10 ciclos completos a 60 Hz ≈ 167 ms de bloqueo
  // Reducir a 10 crossings si la latencia es un problema.
  emon1.calcVI(20, 2000);

  // Obtener resultados
  voltage       = emon1.Vrms;
  current       = emon1.Irms;
  power         = emon1.realPower;       // Potencia real (W) — incluye desfase
  apparentPower = emon1.apparentPower;   // Potencia aparente (VA) = Vrms × Irms

  // --- Factor de potencia ---
  // FP = P_real / P_aparente = cos(φ)
  if (apparentPower > 1.0f) {
    powerFactor = power / apparentPower;
    // Limitar a rango válido [-1, 1]
    powerFactor = constrain(powerFactor, -1.0f, 1.0f);
  } else {
    powerFactor = 1.0f;  // Sin carga → FP indefinido, asumir 1
  }

  // --- Filtro de ruido ---
  // Si la corriente está por debajo del umbral, considerar como 0.
  if (current < UMBRAL_CORRIENTE) {
    current       = 0.0f;
    power         = 0.0f;
    apparentPower = 0.0f;
    powerFactor   = 1.0f;
  }

  // Seguridad: si el voltaje es irrazonablemente bajo, podría haber un error de sensor
  if (voltage < 10.0f) {
    Serial.println(F("⚠ Voltaje demasiado bajo — verificar sensor ZMPT101B"));
  }
}

// ============================================================================
//                          CÁLCULO DE ENERGÍA
// ============================================================================

/**
 * @brief Acumula energía (kWh) con la potencia actual por intervalo.
 *
 * kWh += P(W) × Δt(ms) / 3,600,000,000
 *         ↑           ↑           ↑
 *    potencia real   delta ms   (ms/h × W/kW)
 */
void updateEnergy() {
  unsigned long currentMillis = millis();

  // Primera llamada: inicializar referencia
  if (lastEnergyMillis == 0) {
    lastEnergyMillis = currentMillis;
    return;
  }

  unsigned long deltaMs = currentMillis - lastEnergyMillis;
  lastEnergyMillis = currentMillis;

  // Solo acumular si hay potencia positiva y el delta es razonable
  if (power > 0.0f && deltaMs < 60000UL) {
    kWh += power * ((float)deltaMs / 3600000000.0f);
  }
}

// ============================================================================
//                           PANTALLA OLED
// ============================================================================

/**
 * @brief Dibuja la pantalla principal con mediciones eléctricas.
 */
void drawMeasurements() {
  oled.setTextSize(1);
  oled.setTextColor(WHITE);

  // --- Encabezado ---
  oled.setCursor(0, 0);
  oled.print(F("=== ESPOWER ==="));

  // Indicadores de estado (esquina superior derecha)
  oled.setCursor(108, 0);
  if (WiFi.status() == WL_CONNECTED) {
    oled.print(F("W"));
  } else {
    oled.print(F("!"));
  }
  oled.setCursor(116, 0);
  if (firebaseReady) {
    oled.print(F("F"));
  } else {
    oled.print(F("-"));
  }
  oled.setCursor(124, 0);
  if (ntpSynced) {
    oled.print(F("T"));
  }

  // --- Línea separadora ---
  oled.drawLine(0, 10, 127, 10, WHITE);

  // --- Datos de medición ---
  oled.setCursor(0, 14);
  oled.print(F("V: "));
  oled.print(voltage, 1);
  oled.print(F(" V"));

  oled.setCursor(0, 24);
  oled.print(F("I: "));
  oled.print(current, 3);
  oled.print(F(" A"));

  oled.setCursor(0, 34);
  oled.print(F("P: "));
  oled.print(power, 1);
  oled.print(F(" W"));

  oled.setCursor(0, 44);
  oled.print(F("E: "));
  oled.print(kWh, 4);
  oled.print(F(" kWh"));

  // --- Factor de potencia ---
  oled.setCursor(0, 54);
  oled.print(F("FP: "));
  oled.print(abs(powerFactor), 3);
  oled.print(F("  S:"));
  oled.print(apparentPower, 0);
  oled.print(F("VA"));
}

/**
 * @brief Dibuja la pantalla de estado del sistema.
 */
void drawStatus() {
  oled.setTextSize(1);
  oled.setTextColor(WHITE);

  oled.setCursor(0, 0);
  oled.print(F("=== ESTADO ==="));
  oled.drawLine(0, 10, 127, 10, WHITE);

  // WiFi
  oled.setCursor(0, 14);
  oled.print(F("WiFi: "));
  if (WiFi.status() == WL_CONNECTED) {
    oled.print(F("OK ("));
    oled.print(WiFi.RSSI());
    oled.print(F("dBm)"));
  } else {
    oled.print(F("DESCONECTADO"));
  }

  // IP
  oled.setCursor(0, 24);
  oled.print(F("IP: "));
  if (WiFi.status() == WL_CONNECTED) {
    oled.print(WiFi.localIP());
  } else {
    oled.print(F("---"));
  }

  // Firebase
  oled.setCursor(0, 34);
  oled.print(F("Firebase: "));
  oled.print(firebaseReady ? F("OK") : F("NO"));

  // NTP
  oled.setCursor(0, 44);
  oled.print(F("NTP: "));
  oled.print(ntpSynced ? F("Sincronizado") : F("Esperando..."));

  // LED / relé
  oled.setCursor(0, 54);
  oled.print(F("Rele: "));
  oled.print(firebaseRelayState ? F("ON") : F("OFF"));
}

/**
 * @brief Actualiza la pantalla OLED alternando entre páginas.
 */
void updateOLED() {
  if (!oledInitialized) return;

  // Alternar página cada PAGE_SWITCH_MS
  unsigned long now = millis();
  if (now - lastPageSwitch >= PAGE_SWITCH_MS) {
    lastPageSwitch = now;
    oledPage = (oledPage + 1) % 2;
  }

  oled.clearDisplay();

  switch (oledPage) {
    case 0:
      drawMeasurements();
      break;
    case 1:
      drawStatus();
      break;
  }

  oled.display();
}

// ============================================================================
//                             FIREBASE
// ============================================================================

/**
 * @brief Envía un float a una ruta específica de RTDB.
 */
void sendFloat(const String& path, float value) {
  if (Firebase.RTDB.setFloat(&fbdo, path.c_str(), value)) {
    Serial.printf("  ✓ %.3f → %s\n", value, path.c_str());
  } else {
    Serial.printf("  ✗ Error → %s: %s\n", path.c_str(), fbdo.errorReason().c_str());
  }
}

/**
 * @brief Envía telemetría en tiempo real a Firebase RTDB.
 */
void sendTelemetry() {
  if (!Firebase.ready()) {
    firebaseReady = false;
    return;
  }
  firebaseReady = true;

  unsigned long ts = getTime();
  Serial.printf("[Telemetría] time: %lu | %s\n", ts, getFormattedTime().c_str());

  sendFloat(voltajePath,   voltage);
  sendFloat(corrientePath, current);
  sendFloat(potPath,       power);
  sendFloat(kwhPath,       kWh);
}

/**
 * @brief Envía un registro al datalogger de Firebase.
 *
 * Genera la clave usando la fecha/hora del NTP:
 *   /UsersData/{uid}/datalog/YYYY-MM-DD/HH-MM
 *
 * Evita duplicados comparando con la última clave logueada.
 */
void sendDatalog() {
  if (!Firebase.ready()) return;

  struct tm timeinfo;
  if (!getLocalTime(&timeinfo, 100)) {
    Serial.println(F("⚠ Datalog omitido: NTP no disponible"));
    return;
  }

  // Generar claves de fecha y hora
  char dateBuf[16];
  char hmBuf[8];
  strftime(dateBuf, sizeof(dateBuf), "%Y-%m-%d", &timeinfo);
  strftime(hmBuf,   sizeof(hmBuf),   "%H-%M",    &timeinfo);

  // Control de duplicados
  String minuteKey = String(dateBuf) + " " + String(hmBuf);
  if (minuteKey == lastLoggedMinute) return;  // Ya se logueó este minuto
  lastLoggedMinute = minuteKey;

  // Construir ruta y JSON
  String logPath = datalogPathPrefix + "/" + dateBuf + "/" + hmBuf;

  FirebaseJson logJson;
  logJson.set("voltaje",   voltage);
  logJson.set("corriente", current);
  logJson.set("potencia",  power);
  logJson.set("kwh",       kWh);
  logJson.set("fp",        abs(powerFactor));
  logJson.set("timestamp", (int)getTime());

  bool ok = Firebase.RTDB.setJSON(&fbdo, logPath.c_str(), &logJson);
  if (ok) {
    Serial.printf("[Datalog] ✓ Guardado en %s\n", logPath.c_str());
  } else {
    Serial.printf("[Datalog] ✗ Error: %s\n", fbdo.errorReason().c_str());
  }
}

/**
 * @brief Lee /led desde RTDB y controla GPIO0 y el indicador GPIO2.
 */
void pollLedFromFirebase() {
  if (!Firebase.ready()) return;

  bool newState = firebaseRelayState;
  bool ok = false;

  // Intentar leer como int primero, luego como string
  if (Firebase.RTDB.getInt(&fbdo, ledPath.c_str())) {
    newState = (fbdo.intData() == 1);
    ok = true;
  } else if (Firebase.RTDB.getString(&fbdo, ledPath.c_str())) {
    String v = fbdo.stringData();
    v.trim();
    v.toUpperCase();
    newState = (v == "1" || v == "ON" || v == "TRUE");
    ok = true;
  }

  if (!ok) {
    Serial.println("⚠ Error leyendo /led: " + fbdo.errorReason());
    return;
  }

  firebaseRelayState = newState;
  digitalWrite(PIN_RELE, firebaseRelayState ? HIGH : LOW);
  digitalWrite(PIN_LED_LOCAL, firebaseRelayState ? HIGH : LOW);

  // Solo enviar comando si cambió
  if (firebaseRelayState != lastRelayState) {
    lastRelayState = firebaseRelayState;
    Serial.printf("[LED] Estado cambiado a: %s\n", firebaseRelayState ? "ON" : "OFF");
  }
}

// ============================================================================
//                              WIFI
// ============================================================================

/**
 * @brief Inicializa WiFi usando WiFiManager (portal cautivo).
 * @return true si la conexión fue exitosa.
 */
bool initWiFi() {
  WiFiManager wm;

  // Timeout del portal cautivo (3 minutos)
  wm.setConfigPortalTimeout(180);

  // Nombre del AP para configuración
  Serial.println(F("[WiFi] Iniciando WiFiManager..."));

  if (!wm.autoConnect("ESPOWER_Config")) {
    Serial.println(F("[WiFi] ✗ Fallo al conectar. Reiniciando en 3s..."));
    delay(3000);
    ESP.restart();
    return false;  // Nunca llega aquí
  }

  Serial.println(F("[WiFi] ✓ Conectado!"));
  Serial.print(F("  IP:    ")); Serial.println(WiFi.localIP());
  Serial.print(F("  Canal: ")); Serial.println(WiFi.channel());
  Serial.print(F("  MAC:   ")); Serial.println(WiFi.macAddress());
  Serial.print(F("  RSSI:  ")); Serial.print(WiFi.RSSI()); Serial.println(F(" dBm"));

  return true;
}

/**
 * @brief Verifica el estado de la conexión WiFi y reconecta si es necesario.
 */
void checkWiFiConnection() {
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println(F("[WiFi] ⚠ Desconectado. Intentando reconectar..."));
    WiFi.reconnect();

    // Espera acotada de hasta 5 s; se reintentará en la siguiente iteración.
    unsigned long start = millis();
    while (WiFi.status() != WL_CONNECTED && (millis() - start) < 5000) {
      delay(100);
    }

    if (WiFi.status() == WL_CONNECTED) {
      Serial.println(F("[WiFi] ✓ Reconectado!"));
    } else {
      Serial.println(F("[WiFi] ✗ Reconexión fallida — reintentando después..."));
    }
  }
}

// ============================================================================
//                               NTP
// ============================================================================

/**
 * @brief Configura la sincronización NTP.
 */
void initNTP() {
  configTime(GMT_OFFSET, DST_OFFSET, NTP_SERVER_1, NTP_SERVER_2);
  Serial.println(F("[NTP] Configurado. Esperando sincronización..."));

  // Esperar sincronización inicial (máx 10 s)
  struct tm timeinfo;
  int retries = 0;
  while (!getLocalTime(&timeinfo, 1000) && retries < 10) {
    Serial.print(F("."));
    retries++;
  }

  if (retries < 10) {
    ntpSynced = true;
    Serial.printf("\n[NTP] ✓ Hora sincronizada: %s\n", getFormattedTime().c_str());
  } else {
    Serial.println(F("\n[NTP] ⚠ Sincronización inicial fallida — reintentará"));
  }
}

// ============================================================================
//                         INICIALIZACIÓN FIREBASE
// ============================================================================

/**
 * @brief Configura e inicializa la conexión a Firebase.
 */
void initFirebase() {
  config.api_key     = API_KEY;
  config.database_url = DATABASE_URL;
  auth.user.email    = USER_EMAIL;
  auth.user.password = USER_PASSWORD;

  // Optimizar uso de memoria
  fbdo.setResponseSize(1024);

  // Callback para estado del token
  config.token_status_callback = tokenStatusCallback;

  // Reconexión automática de WiFi dentro de Firebase
  Firebase.reconnectWiFi(true);

  // Iniciar Firebase
  Firebase.begin(&config, &auth);

  // Esperar autenticación (obtener UID)
  Serial.print(F("[Firebase] Autenticando"));
  unsigned long authStart = millis();
  while (auth.token.uid == "" && (millis() - authStart) < 15000) {
    Serial.print(F("."));
    delay(500);
  }

  if (auth.token.uid == "") {
    Serial.println(F("\n[Firebase] ✗ No se pudo obtener UID. Reiniciando..."));
    delay(2000);
    ESP.restart();
  }

  uid = auth.token.uid.c_str();
  Serial.printf("\n[Firebase] ✓ Autenticado | UID: %s\n", uid.c_str());

  // Construir rutas
  databasePath      = "/UsersData/" + uid;
  telemetryPath     = databasePath + "/telemetry";
  voltajePath       = telemetryPath + "/voltaje";
  corrientePath     = telemetryPath + "/corriente";
  potPath           = telemetryPath + "/potencia";
  kwhPath           = telemetryPath + "/kwh";
  ledPath           = databasePath + "/led";
  datalogPathPrefix = databasePath + "/datalog";

  firebaseReady = true;
}

// ============================================================================
//                          SENSORES - INIT
// ============================================================================

/**
 * @brief Inicializa los sensores de voltaje y corriente.
 *
 * Calibración de EmonLib:
 *   emon1.voltage(pin, cal, phase_shift)
 *     - pin        : Pin analógico
 *     - cal        : Constante de calibración de voltaje
 *     - phase_shift: Coeficiente de compensación de fase de EmonLib
 *
 *   emon1.current(pin, cal)
 *     - pin : Pin analógico
 *     - cal : Constante de calibración de corriente
 */
void initSensors() {
  // Configurar ADC a 12 bits (0–4095) — ya es el default del ESP32
  analogReadResolution(12);

  // Se recomienda atenuación de 11 dB para el rango 0–3.3V
  analogSetAttenuation(ADC_11db);

  // Inicializar EmonLib
  emon1.voltage(PIN_VOLTAJE,   CONSTANTE_V, FASE);
  emon1.current(PIN_CORRIENTE, CONSTANTE_I);

  Serial.println(F("[Sensores] ✓ EmonLib inicializado"));
  Serial.printf("  Voltaje  : pin=%d, cal=%.2f, fase=%.1f\n", PIN_VOLTAJE, CONSTANTE_V, FASE);
  Serial.printf("  Corriente: pin=%d, cal=%.1f\n", PIN_CORRIENTE, CONSTANTE_I);
}

// ============================================================================
//                        PERSISTENCIA (NVS)
// ============================================================================

/**
 * @brief Carga el valor de kWh desde la memoria NVS.
 */
void loadPreferences() {
  preferences.begin("energy", false);
  kWh = preferences.getFloat("kwh_total", 0.0f);
  Serial.printf("[NVS] kWh cargado: %.4f\n", kWh);
}

/**
 * @brief Guarda el valor de kWh en la memoria NVS.
 */
void savePreferences() {
  preferences.putFloat("kwh_total", kWh);
  Serial.printf("[NVS] kWh guardado: %.4f\n", kWh);
}

// ============================================================================
//                        OLED - INIT
// ============================================================================

/**
 * @brief Inicializa la pantalla OLED.
 */
void initOLED() {
  Wire.begin(21, 22);  // SDA=21, SCL=22

  if (!oled.begin(SSD1306_SWITCHCAPVCC, SCREEN_ADDRESS)) {
    Serial.println(F("[OLED] ✗ Error al iniciar pantalla"));
    oledInitialized = false;
    return;
  }

  oledInitialized = true;
  oled.clearDisplay();
  oled.setTextSize(1);
  oled.setTextColor(WHITE);
  oled.setCursor(10, 20);
  oled.print(F("ESPOWER v2.0"));
  oled.setCursor(10, 35);
  oled.print(F("Iniciando..."));
  oled.display();
  Serial.println(F("[OLED] ✓ Pantalla inicializada"));
}

// ============================================================================
//                           SETUP
// ============================================================================

void setup() {
  // --- Comunicación serial ---
  Serial.begin(115200);
  while (!Serial && millis() < 3000);  // Esperar serial (máx 3s)

  Serial.println(F("\n"));
  Serial.println(F("╔══════════════════════════════════════╗"));
  Serial.println(F("║    ESPOWER Monitor v2.0              ║"));
  Serial.println(F("║    Sistema de Monitoreo de Energía   ║"));
  Serial.println(F("╚══════════════════════════════════════╝"));
  Serial.println();

  // --- Pin LED ---
  pinMode(PIN_LED_LOCAL, OUTPUT);
  digitalWrite(PIN_LED_LOCAL, LOW);
  // GPIO0 selecciona el modo de arranque; confirmar que la etapa externa no
  // lo mantenga bajo durante reset. La salida es activa en HIGH según esquema.
  digitalWrite(PIN_RELE, LOW);
  pinMode(PIN_RELE, OUTPUT);

  // --- OLED ---
  initOLED();

  // --- Sensores ---
  initSensors();

  // --- NVS ---
  loadPreferences();

  // --- WiFi (WiFiManager) ---
  initWiFi();

  // --- NTP ---
  initNTP();

  // --- Firebase ---
  initFirebase();

  // --- Estado inicial del relé ---
  pollLedFromFirebase();

  // --- Timestamp de referencia ---
  lastEnergyMillis = millis();

  Serial.println(F("\n[SETUP] ✓ Sistema listo!\n"));

  // Mostrar config
  Serial.printf("[CONFIG] Intervalo datalog: %lu min\n", DATALOG_INTERVAL_MINUTES);
  Serial.printf("[CONFIG] Intervalo telemetría: %lu ms\n", FIREBASE_SEND_INTERVAL_MS);
  Serial.printf("[CONFIG] Intervalo sensor: %lu ms\n", SENSOR_INTERVAL_MS);
  Serial.println();
}

// ============================================================================
//                            LOOP
// ============================================================================

void loop() {
  unsigned long nowMs = millis();

  // ── 1) LECTURA DE SENSORES ──────────────────────────────────────────────
  if (nowMs - lastSensorMillis >= SENSOR_INTERVAL_MS) {
    lastSensorMillis = nowMs;
    readSensors();
    updateEnergy();

    // Log al serial (debug)
    Serial.printf("V:%.1f | I:%.3f | P:%.1f | S:%.1f | FP:%.3f | kWh:%.4f\n",
                  voltage, current, power, apparentPower, powerFactor, kWh);
  }

  // ── 2) ACTUALIZAR OLED ─────────────────────────────────────────────────
  if (nowMs - lastDisplayMillis >= DISPLAY_INTERVAL_MS) {
    lastDisplayMillis = nowMs;
    updateOLED();
  }

  // ── 3) VERIFICAR WIFI ──────────────────────────────────────────────────
  if (nowMs - lastWiFiCheckMillis >= WIFI_CHECK_INTERVAL_MS) {
    lastWiFiCheckMillis = nowMs;
    checkWiFiConnection();
  }

  // ── 4) POLL LED DESDE FIREBASE ─────────────────────────────────────────
  if (nowMs - lastFirebasePollMillis >= FIREBASE_POLL_INTERVAL_MS) {
    lastFirebasePollMillis = nowMs;
    pollLedFromFirebase();
  }

  // ── 5) ENVIAR TELEMETRÍA ───────────────────────────────────────────────
  if (nowMs - lastFirebaseSendMillis >= FIREBASE_SEND_INTERVAL_MS) {
    lastFirebaseSendMillis = nowMs;
    sendTelemetry();
  }

  // ── 6) DATALOG ─────────────────────────────────────────────────────────
  if (nowMs - lastDatalogMillis >= (DATALOG_INTERVAL_MINUTES * 60000UL)) {
    lastDatalogMillis = nowMs;
    sendDatalog();
  }

  // ── 7) GUARDAR kWh EN FLASH ────────────────────────────────────────────
  if (nowMs - lastPrefsSaveMillis >= PREFS_SAVE_INTERVAL_MS) {
    lastPrefsSaveMillis = nowMs;
    savePreferences();
  }
}
