# Pruebas del servidor

```bash
npm test
```

Las pruebas de respaldos usan un Google Drive simulado (`google-falso.js`) y, si están levantados, un servidor SFTP real en `127.0.0.1:2222` y uno FTPS en `127.0.0.1:2121`, con el usuario `bkuser` y la clave `Clave-Prueba-123`. Sin esos servidores, esas partes se saltan.
