(function () {
    "use strict";
    // Fake Deafen v2.0 - Revenge clasico / Vendetta.
    // /dfon y /dfoff son comandos BUILT_IN ejecutados solo en el cliente.
    // No toca el audio local; modifica el estado de voz que se manda al gateway.

    var api = vendetta;
    var React = api.metro.common.React;
    var RN = api.metro.common.ReactNative;
    var findByProps = api.metro.findByProps;
    var storage = api.plugin.storage;

    var loaded = false;
    var enabled = false;          // Preferencia: NO se reinicia al salir de voz.
    var transport = null;         // Conexion que vimos transmitir una actualizacion.
    var lastReal = null;          // Ultimo estado REAL, antes de la alteracion.
    var restore = [];
    var patchedSockets = [];
    var moduleDispatchDepth = 0;
    var refreshSettings = null;
    var commandRemovers = [];
    var commandTimer = null;
    var commandAttempts = 0;
    var commandStatus = "Esperando API de comandos...";
    var flux = null;
    var onConnection = null;
    var status = "Esperando conexion de voz...";

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
    function find(names) {
        try { return findByProps.apply(null, names); } catch (_) { return null; }
    }
    function getSocket() {
        try {
            var store = find(["getSocket"]);
            return store && typeof store.getSocket === "function" ? store.getSocket() : null;
        } catch (_) { return null; }
    }
    function getVoiceId() {
        try {
            var store = find(["getVoiceChannelId"]);
            var id = store && store.getVoiceChannelId();
            return typeof id === "string" && id ? id : null;
        } catch (_) { return null; }
    }
    function currentVoiceState() {
        var id = getVoiceId();
        if (!id) return null;
        try {
            var channelStore = find(["getChannel"]);
            var channel = channelStore && channelStore.getChannel(id);
            if (!channel) return null;
            var guildId = channel.guild_id || channel.guildId || null;
            var voice = find(["isSelfDeaf", "isSelfMute"]);
            return {
                guild_id: String(guildId || "") || null,
                channel_id: id,
                self_mute: voice && typeof voice.isSelfMute === "function" ? !!voice.isSelfMute() : false,
                self_deaf: voice && typeof voice.isSelfDeaf === "function" ? !!voice.isSelfDeaf() : false
            };
        } catch (_) { return null; }
    }
    function isVoicePacket(packet) {
        var d = packet && packet.d;
        return packet && packet.op === 4 && d && typeof d === "object" &&
            (typeof d.channel_id === "string" || d.channel_id === null) &&
            typeof d.self_mute === "boolean" && typeof d.self_deaf === "boolean" &&
            (typeof d.guild_id === "string" || d.guild_id === null);
    }
    function remember(packet, kind, sender, source) {
        // Una desconexion borra solo la sesion, NO la preferencia enabled.
        if (packet.d.channel_id === null) {
            lastReal = null;
            transport = null;
            status = enabled ? "Fake Deafen activado: se aplicara al volver a voz." : "Sin conexion de voz.";
            redraw();
            return;
        }
        transport = { kind: kind, sender: sender, source: source };
        lastReal = { op: 4, d: Object.assign({}, packet.d) };
        status = enabled ? "Fake Deafen activado en voz." : "Conectado: modo normal.";
        redraw();
    }
    function spoof(packet) {
        if (!enabled || !packet.d.channel_id) return packet;
        return {
            op: 4,
            d: Object.assign({}, packet.d, { self_mute: true, self_deaf: true })
        };
    }

    // Metodo A: WebSocket de RN (si el cliente lo expone).
    function attachWebSocket() {
        try {
            var WS = typeof WebSocket === "function" ? WebSocket : null;
            if (!WS || !WS.prototype || typeof WS.prototype.send !== "function") return false;
            var original = WS.prototype.send;
            var wrapper = function (data) {
                if (!loaded || moduleDispatchDepth || typeof data !== "string")
                    return original.apply(this, arguments);
                try {
                    var packet = JSON.parse(data);
                    if (isVoicePacket(packet)) {
                        remember(packet, "ws", original, this);
                        var changed = spoof(packet);
                        if (changed !== packet) {
                            var args = Array.prototype.slice.call(arguments);
                            args[0] = JSON.stringify(changed);
                            return original.apply(this, args);
                        }
                    }
                } catch (_) {}
                return original.apply(this, arguments);
            };
            WS.prototype.send = wrapper;
            if (WS.prototype.send !== wrapper) return false;
            restore.push(function () { if (WS.prototype.send === wrapper) WS.prototype.send = original; });
            return true;
        } catch (error) { log("No se pudo interceptar WebSocket", error); return false; }
    }

    // Metodo B: GatewayConnectionStore. Reinstala el parche si Discord cambia el socket.
    function attachGatewayModule() {
        try {
            var socket = getSocket();
            if (!socket || typeof socket.send !== "function" ||
                typeof socket.voiceStateUpdate !== "function") return false;
            for (var i = 0; i < patchedSockets.length; i++) {
                if (patchedSockets[i].socket === socket) return true;
            }
            var original = socket.send;
            var wrapper = function (op, payload) {
                if (loaded && op === 4 && payload && isVoicePacket({ op: op, d: payload })) {
                    remember({ op: 4, d: payload }, "module", original, this);
                    var changed = spoof({ op: 4, d: payload });
                    if (changed.d !== payload) {
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
            socket.send = wrapper;
            if (socket.send !== wrapper) return false;
            patchedSockets.push({ socket: socket, original: original, wrapper: wrapper });
            restore.push(function () { if (socket.send === wrapper) socket.send = original; });
            return true;
        } catch (error) { log("No se pudo interceptar el gateway", error); return false; }
    }

    function connectionAlive() {
        if (!transport || !lastReal || !lastReal.d.channel_id) return false;
        if (transport.kind === "ws" && transport.source.readyState !== 1) return false;
        if (transport.kind === "module" && getSocket() !== transport.source) return false;
        // Si la store conoce el canal, no enviar estado de uno anterior.
        var current = getVoiceId();
        if (current && current !== lastReal.d.channel_id) return false;
        return true;
    }

    // Si el plugin se activo despues de entrar a voz, intenta localizar el socket
    // y preparar un estado inicial; no obliga a abandonar ni reentrar al canal.
    function obtainLiveTransport() {
        attachGatewayModule();
        if (connectionAlive()) return true;
        transport = null;
        lastReal = null;
        var socket = getSocket();
        var real = currentVoiceState();
        if (!socket || !real || typeof socket.send !== "function" ||
            typeof socket.voiceStateUpdate !== "function") return false;
        var original = null;
        for (var i = 0; i < patchedSockets.length; i++) {
            if (patchedSockets[i].socket === socket) original = patchedSockets[i].original;
        }
        if (!original) return false;
        transport = { kind: "module", sender: original, source: socket };
        lastReal = { op: 4, d: real };
        return true;
    }

    // Se envia op=4 AHORA MISMO: actualiza el icono sin reconectar y no silencia
    // el audio local. Se usa el sender original para no guardar un estado falso.
    function sendCurrentState() {
        if (!obtainLiveTransport()) return false;
        try {
            var packet = spoof({ op: 4, d: Object.assign({}, lastReal.d) });
            if (transport.kind === "ws") {
                transport.sender.call(transport.source, JSON.stringify(packet));
            } else {
                transport.sender.call(transport.source, 4, packet.d);
            }
            return true;
        } catch (error) {
            log("No se pudo enviar VOICE_STATE_UPDATE", error);
            return false;
        }
    }

    function setMode(next) {
        if (!loaded) return;
        enabled = !!next;
        try { storage.enabled = enabled; } catch (error) { log("No se pudo guardar la preferencia", error); }
        var inVoice = !!getVoiceId() || connectionAlive();
        var sent = inVoice ? sendCurrentState() : false;
        if (sent) {
            status = enabled ? "Estado Fake Deafen enviado inmediatamente." : "Estado normal enviado inmediatamente.";
            toast(enabled ? "Fake Deafen: ACTIVADO" : "Fake Deafen: DESACTIVADO");
        } else if (!inVoice) {
            status = enabled ? "ACTIVO: se aplicara automaticamente al entrar a voz." : "INACTIVO: estado normal al entrar a voz.";
            toast(enabled ? "/dfon guardado: se aplicara al entrar a voz." : "/dfoff guardado: modo normal.");
        } else {
            status = "Preferencia guardada, pero no se pudo enviar ahora. Es posible que el icono tarde en actualizarse.";
            toast("No se pudo actualizar la voz inmediatamente; revisa la conexion.");
        }
        redraw();
    }

    function registerCommands() {
        if (!loaded || commandRemovers.length) return;
        commandAttempts++;
        var added = [];
        try {
            if (!api.commands || typeof api.commands.registerCommand !== "function")
                throw new Error("No existe la API de comandos BUILT_IN");
            [
                { name: "dfon", description: "Activar Fake Deafen sin salir de voz", next: true },
                { name: "dfoff", description: "Desactivar Fake Deafen sin salir de voz", next: false }
            ].forEach(function (entry) {
                var undo = api.commands.registerCommand({
                    name: entry.name,
                    displayName: entry.name,
                    description: entry.description + " (local)",
                    displayDescription: entry.description + " (local)",
                    applicationId: "-1",
                    type: 1,
                    inputType: 0, // BUILT_IN; no es un comando de bot ni se envia al chat.
                    options: [],
                    execute: function () {
                        setMode(entry.next);
                        return; // Nunca devolver un objeto de mensaje (ni enviar texto).
                    }
                });
                if (typeof undo !== "function") throw new Error("No se recibio funcion de desregistro");
                added.push(undo);
            });
            commandRemovers = added;
            commandStatus = "/dfon y /dfoff registrados (BUILT-IN)";
        } catch (error) {
            added.forEach(function (undo) { try { undo(); } catch (_) {} });
            commandStatus = "Error registrando comandos (intento " + commandAttempts + ")";
            log(commandStatus, error);
            if (loaded && commandAttempts < 5 && typeof setTimeout === "function") {
                commandTimer = setTimeout(function () { commandTimer = null; registerCommands(); }, 1500);
            }
        }
        redraw();
    }

    function watchConnection() {
        try {
            flux = api.metro.common.FluxDispatcher || find(["subscribe", "unsubscribe", "dispatch"]);
            if (!flux || typeof flux.subscribe !== "function" || typeof flux.unsubscribe !== "function") return;
            onConnection = function () { if (loaded) attachGatewayModule(); };
            flux.subscribe("CONNECTION_OPEN", onConnection);
            flux.subscribe("CONNECTION_RESUMED", onConnection);
        } catch (error) { log("No se pudo vigilar reconexiones", error); }
    }

    function SettingsScreen() {
        var state = React.useState(0);
        var rerender = state[1];
        React.useEffect(function () {
            refreshSettings = function () { rerender(function (n) { return n + 1; }); };
            return function () { refreshSettings = null; };
        }, []);
        var h = React.createElement;
        function label(value, style) {
            return h(RN.Text, {
                style: Object.assign({ color: "#f7f7fa", fontSize: 15, lineHeight: 24 }, style || {})
            }, value);
        }
        return h(RN.ScrollView, {
            contentContainerStyle: { padding: 18, paddingBottom: 45, backgroundColor: "#17181c" }
        }, h(RN.View, null,
            label("FAKE DEAFEN v2.0", { fontSize: 23, fontWeight: "bold", marginBottom: 8 }),
            label("Modo persistente: " + (enabled ? "ACTIVADO" : "DESACTIVADO"), {
                color: enabled ? "#70e9a7" : "#f9ca75", fontSize: 18, fontWeight: "bold"
            }),
            label(status, { color: "#c6c7d3", marginTop: 10 }),
            label(commandStatus, { color: "#96a2ff", marginTop: 12 }),
            label("COMANDOS LOCALES", { fontWeight: "bold", fontSize: 18, marginTop: 22 }),
            label("/dfon  -  Activa el ensordecimiento falso.\n/dfoff  -  Vuelve al estado normal."),
            label("Escribe el comando en cualquier chat y seleccionalo entre los Built-in. No se publica ningun mensaje.", {
                color: "#b4b6c4", marginTop: 12
            }),
            label("La preferencia se conserva al salir de voz, cambiar de canal y reiniciar Discord. Si no estas conectado, se aplicara en la proxima entrada.", {
                color: "#b4b6c4", marginTop: 14
            }),
            label("El icono se actualiza enviando un nuevo estado de voz, sin tocar el audio local. La compatibilidad depende del gateway de Discord de tu version.", {
                color: "#858897", fontSize: 13, marginTop: 24
            })
        ));
    }

    return {
        onLoad: function () {
            loaded = true;
            try { enabled = storage.enabled === true; } catch (_) { enabled = false; }
            transport = null;
            lastReal = null;
            commandAttempts = 0;
            commandRemovers = [];
            status = enabled ? "Modo activado: esperando voz o actualizacion de estado." : "Modo normal.";
            var wsOK = attachWebSocket();
            var gatewayOK = attachGatewayModule();
            watchConnection();
            registerCommands();
            if (!wsOK && !gatewayOK) {
                status = "No se detecto gateway compatible. Los comandos pueden guardar la preferencia, pero no enviar el estado.";
            }
            redraw();
        },
        onUnload: function () {
            // Al desinstalar/deshabilitar el plugin, restaurar estado real si sigue en voz.
            if (enabled) {
                enabled = false;
                sendCurrentState();
            }
            loaded = false;
            if (commandTimer !== null && typeof clearTimeout === "function") {
                try { clearTimeout(commandTimer); } catch (_) {}
            }
            commandTimer = null;
            commandRemovers.forEach(function (undo) { try { undo(); } catch (_) {} });
            commandRemovers = [];
            if (flux && onConnection) {
                try { flux.unsubscribe("CONNECTION_OPEN", onConnection); } catch (_) {}
                try { flux.unsubscribe("CONNECTION_RESUMED", onConnection); } catch (_) {}
            }
            flux = null;
            onConnection = null;
            restore.reverse().forEach(function (undo) { try { undo(); } catch (_) {} });
            restore = [];
            patchedSockets = [];
            transport = null;
            lastReal = null;
            refreshSettings = null;
            status = "Plugin detenido.";
            // storage.enabled no se modifica: se reanudara al volver a habilitarlo.
        },
        settings: SettingsScreen
    };
})()
