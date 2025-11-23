/**
 * LOGGING SYSTEM
 */
const Logger = {
    logs: [],
    maxLogs: 1000, // Keep last 1000 log entries

    log: function(level, message, data = null) {
        const timestamp = new Date().toISOString();
        const logEntry = {
            timestamp,
            level, // 'info', 'warn', 'error', 'debug'
            message,
            data: data ? JSON.parse(JSON.stringify(data)) : null // Deep clone to avoid reference issues
        };
        
        this.logs.push(logEntry);
        
        // Keep only last maxLogs entries
        if (this.logs.length > this.maxLogs) {
            this.logs.shift();
        }
        
        // Also log to console for immediate debugging
        const consoleMethod = level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'log';
        console[consoleMethod](`[${timestamp}] ${level.toUpperCase()}: ${message}`, data || '');
    },

    info: function(message, data) {
        this.log('info', message, data);
    },

    warn: function(message, data) {
        this.log('warn', message, data);
    },

    error: function(message, data) {
        this.log('error', message, data);
    },

    debug: function(message, data) {
        this.log('debug', message, data);
    },

    clear: function() {
        this.logs = [];
        this.info('Logs cleared');
    },

    export: function() {
        const logText = this.logs.map(entry => {
            let line = `[${entry.timestamp}] ${entry.level.toUpperCase()}: ${entry.message}`;
            if (entry.data) {
                line += '\n' + JSON.stringify(entry.data, null, 2);
            }
            return line;
        }).join('\n\n');

        // Create a blob and download it
        const blob = new Blob([logText], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `sightread-logs-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        
        this.info('Logs exported to file');
    },

    getLogs: function() {
        return this.logs;
    }
};

