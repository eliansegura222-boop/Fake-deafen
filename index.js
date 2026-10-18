(function () {
    "use strict";
    /*
     * Fake Deafen - Revenge clasico / Vendetta-compatible (experimental)
     * Compiled loader expression: Vendetta/Revenge evaluates `vendetta => { return <this file> }`.
     * No external JavaScript dependencies or bundling required.
     * Only targets Discord gateway voice-state packets (opcode 4).
     */
    

    var api = vendetta;
    var React = api.metro.common.React;
    var RN = api.metro.common.ReactNative;
    var findByProps = api.metro.findByProps;
    var storage = api.plugin.storage;

    var active = false;
    var loaded = false;
    var transport = null;
    var lastReal = null;
    var restore = [];
    var refreshSettings = null;
    var moduleDispatchDepth = 0;
    var modulePatched = false;
    var status = "Esperando un paquete de voz...";

    function log(message, error) {
        try { console.log("[FakeDeafen] " + message, error || ""); } catch (_) {}
    }

    function toast(message) {
        try { api.ui.toasts.showToast(message); } catch (_) {}
        log(message);
    }

    function redraw() {
        try { if (refreshSettings) refreshSettings(); } catch (_) {}
    }

    function isVoicePacket(packet) {
        return packet && typeof packet === "object" &&
            packet.op === 4 && packet.d && typeof packet.d === "object" &&
            (typeof packet.d.channel_id === "string" || packet.d.channel_id === null) &&
            typeof packet.d.self_mute === "boolean" &&
            typeof packet.d.self_deaf === "boolean" &&
            (packet.d.guild_id === null || typeof packet.d.guild_id === "string");
    }

    // Keep the real state independently of any modified outgoing payload.
    function remember(packet, kind, sender, source) {
        if (!packet.d.channel_id) {
            lastReal = null;
            active = false;
            status = "Sin canal de voz. Entra a uno para empezar.";
            redraw();
            return;
        }
        transport = { kind: kind, sender: sender, source: source };
        lastReal = {
            op: 4,
            d: Object.assign({}, packet.d),
        };
        status = "Canal de voz detectado. Puedes activar Fake Deafen.";
        redraw();
    }

    function fakePacket(packet) {
        if (!active || !packet.d.channel_id) return packet;
        return Object.assign({}, packet, {
            d: Object.assign({}, packet.d, { self_mute: true, self_deaf: true }),
        });
    }

    // Runtime A: React Native's WebSocket sends serialized gateway JSON packets.
    function attachWebSocket() {
        try {
            var WS = typeof WebSocket !== "undefined" ? WebSocket : null;
            if (!WS || !WS.prototype || typeof WS.prototype.send !== "function") return false;
            var original = WS.prototype.send;
            var wrapper = function (data) {
                if (!loaded || typeof data !== "string" || moduleDispatchDepth > 0) {
                    return original.apply(this, arguments);
                }
                try {
                    var packet = JSON.parse(data);
                    if (isVoicePacket(packet)) {
                        remember(packet, "ws", original, this);
                        var changed = fakePacket(packet);
                        if (changed !== packet) {
                            var newArgs = Array.prototype.slice.call(arguments);
                            newArgs[0] = JSON.stringify(changed);
                            return original.apply(this, newArgs);
                        }
                    }
                } catch (e) { /* Leave non-JSON and unsupported payloads unchanged. */ }
                return original.apply(this, arguments);
            };
            WS.prototype.send = wrapper;
            if (WS.prototype.send !== wrapper) return false;
            restore.push(function () {
                if (WS.prototype.send === wrapper) WS.prototype.send = original;
            });
            return true;
        } catch (e) {
            log("No se pudo interceptar WebSocket", e);
            return false;
        }
    }

    // Runtime B: some Android releases expose a gateway socket with send(op, data).
    function attachGatewayModule() {
        if (modulePatched) return true;
        try {
            var mod = findByProps("getSocket");
            var sock = mod && typeof mod.getSocket === "function" ? mod.getSocket() : null;
            if (!sock || typeof sock.send !== "function") return false;
            // Guard against accidentally patching a completely unrelated socket.
            if (typeof sock.voiceStateUpdate !== "function") return false;
            var original = sock.send;
            var wrapper = function (op, payload) {
                if (loaded && op === 4 && payload && typeof payload === "object" &&
                    isVoicePacket({ op: op, d: payload })) {
                    var packet = { op: 4, d: payload };
                    remember(packet, "module", original, this);
                    var changed = fakePacket(packet);
                    if (changed !== packet) {
                        var args = Array.prototype.slice.call(arguments);
                        args[1] = changed.d;
                        moduleDispatchDepth++;
                        try { return original.apply(this, args); }
                        finally { moduleDispatchDepth--; }
                    }
                }
                moduleDispatchDepth++;
                try { return original.apply(this, arguments); }
                finally { moduleDispatchDepth--; }
            };
            sock.send = wrapper;
            if (sock.send !== wrapper) return false;
            modulePatched = true;
            restore.push(function () { if (sock.send === wrapper) sock.send = original; modulePatched = false; });
            return true;
        } catch (e) {
            log("No se encontró un módulo de gateway compatible", e);
            return false;
        }
    }

    function connectionAlive() {
        return transport && lastReal && lastReal.d.channel_id &&
            (transport.kind !== "ws" || transport.source.readyState === 1);
    }

    // Sends the most recently observed REAL state through the native transport.
    // Avoids using local deafen or muting any audio streams.
    function synchronize() {
        if (!connectionAlive()) return false;
        try {
            var packet = fakePacket({ op: 4, d: Object.assign({}, lastReal.d) });
            if (transport.kind === "ws") {
                transport.sender.call(transport.source, JSON.stringify(packet));
            } else {
                transport.sender.call(transport.source, 4, packet.d);
            }
            return true;
        } catch (e) {
            log("Fallo al enviar estado de voz", e);
            status = "Fallo al enviar el estado. Reconecta al canal de voz.";
            return false;
        }
    }

    function setActive(next) {
        if (!loaded) return false;
        if (next && !connectionAlive()) {
            status = "Entra a un canal de voz después de encender el plugin. Si ya estás dentro, sal y vuelve a entrar.";
            toast("No se detectó el canal. Sal y vuelve a entrar a voz.");
            redraw();
            return false;
        }
        var previous = active;
        active = Boolean(next);
        if (!synchronize()) {
            active = previous;
            toast("No se pudo actualizar el estado en el servidor.");
            redraw();
            return false;
        }
        status = active
            ? "Estado falso enviado. Confírmalo desde otra cuenta."
            : "Estado real enviado al servidor.";
        toast(active ? "Fake Deafen: ACTIVADO (experimental)" : "Fake Deafen: DESACTIVADO");
        redraw();
        return true;
    }

    function SettingsScreen() {
        var _state = React.useState(0);
        var rerender = _state[1];
        React.useEffect(function () {
            refreshSettings = function () { rerender(function (n) { return n + 1; }); };
            return function () { refreshSettings = null; };
        }, []);

        var element = React.createElement;
        var text = function (value, more) {
            return element(RN.Text, {
                style: Object.assign({ color: "#F5F5F5", fontSize: 15, lineHeight: 22 }, more || {})
            }, value);
        };
        var button = function (label, fn, enabled) {
            return element(RN.TouchableOpacity, {
                key: label,
                onPress: fn,
                disabled: !enabled,
                style: {
                    borderRadius: 12, paddingVertical: 14, paddingHorizontal: 14,
                    backgroundColor: enabled ? "#5558f6" : "#42454b", marginTop: 10
                }
            }, text(label, { textAlign: "center", fontWeight: "bold", color: enabled ? "white" : "#b1b1b1" }));
        };
        return element(RN.ScrollView, {
            contentContainerStyle: { padding: 18, paddingBottom: 40, backgroundColor: "#17181c" }
        }, element(RN.View, null,
            text("FAKE DEAFEN", { fontSize: 22, fontWeight: "bold", marginBottom: 6 }),
            text("Para Revenge clásico / Vendetta", { color: "#a9aab5", marginBottom: 16 }),
            text("Estado: " + (active ? "ACTIVO" : "INACTIVO"), {
                color: active ? "#64e6a7" : "#f5cf70", fontSize: 18, fontWeight: "bold"
            }),
            text(status, { color: "#c6c6d2", marginTop: 10 }),
            button("ACTIVAR FAKE DEAFEN", function () { setActive(true); }, !active),
            button("DESACTIVAR FAKE DEAFEN", function () { setActive(false); }, active),
            button("VOLVER A BUSCAR GATEWAY", function () {
                if (attachGatewayModule()) {
                    toast("Módulo gateway encontrado; reconéctate a voz si aún no se detecta.");
                } else {
                    toast("No se encontró módulo compatible. Intenta salir y entrar a voz.");
                }
                redraw();
            }, true),
            text("INSTRUCCIONES", { fontSize: 18, fontWeight: "bold", marginTop: 24 }),
            text("1. Activa el plugin en Revenge.\n2. Entra a un canal de voz (o sal y vuelve a entrar).\n3. Abre estos ajustes y activa Fake Deafen.\n4. Comprueba el icono con otra cuenta.", { marginTop: 8 }),
            text("Este plugin intercepta únicamente mensajes de estado de voz. La compatibilidad depende de Discord Android. Si no detecta paquetes de voz, no simulará estar activo.", {
                marginTop: 18, color: "#a9aab5", fontSize: 13
            })
        ));
    }

    return {
        onLoad: function () {
            loaded = true;
            active = false;
            transport = null;
            lastReal = null;
            modulePatched = false;
            status = "Conéctate a voz después de iniciar el plugin.";
            var wsOK = attachWebSocket();
            var moduleOK = attachGatewayModule();
            if (!wsOK && !moduleOK) {
                status = "No se pudo interceptar el gateway de Discord en esta versión.";
                toast("Fake Deafen: gateway no compatible.");
            } else {
                log("Cargado. Transporte WebSocket=" + wsOK + ", modulo=" + moduleOK);
            }
            redraw();
        },
        onUnload: function () {
            if (active) {
                active = false;
                synchronize(); // Restore the real state before uninstalling interceptors.
            }
            loaded = false;
            restore.reverse().forEach(function (undo) { try { undo(); } catch (_) {} });
            restore = [];
            transport = null;
            lastReal = null;
            status = "Plugin detenido.";
            redraw();
        },
        settings: SettingsScreen
    };
})()
