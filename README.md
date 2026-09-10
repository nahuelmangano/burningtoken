# Ephemeral Deploy

Ephemeral Deploy es un launcher web para probar imágenes Docker y pequeños stacks Docker Compose en sesiones temporales. Permite pegar una imagen o un archivo Compose, iniciar los contenedores mediante el socket de Docker y acceder al servicio web desde un preview integrado en la página.

Las sesiones son efímeras: se eliminan después de un período sin actividad o cuando el usuario las destruye. Los contenedores, redes y volúmenes creados por el runner se identifican con labels propios para poder limpiarlos.

## Ejecución

La aplicación necesita acceso al daemon Docker. En desarrollo:

```bash
npm install
npm start
```

También puede ejecutarse con Docker Compose:

```bash
docker compose up -d --build
```

La interfaz queda disponible en `http://localhost:3000`.

## Compose mínimo de ejemplo

El stack debe tener un único servicio web con un puerto publicado:

```yaml
services:
  web:
    image: nginx:alpine
    ports:
      - "8080:80"
```

El primer puerto es el puerto del host y el segundo es el puerto donde escucha la aplicación dentro del contenedor. El runner asigna internamente un puerto temporal para el preview.

## Restricciones actuales

- Solo se permite un servicio web por stack: exactamente un servicio debe declarar `ports`.
- Los servicios deben usar una imagen Docker válida. `build` no está soportado.
- No se permiten `container_name`, `restart`, `privileged`, `network_mode`, `pid`, `ipc`, `devices`, `cap_add`, `cap_drop` ni `security_opt`.
- No se permiten bind mounts, rutas del host, `tmpfs` ni el socket `/var/run/docker.sock` dentro de los servicios.
- Los volúmenes deben ser Docker volumes nombrados, con un destino absoluto dentro del contenedor. Se crean de forma temporal y se eliminan junto con la sesión.
- Se permiten como máximo cuatro volúmenes por stack.
- Las dependencias deben declararse con `depends_on` y no pueden formar ciclos.
- Solo se permite un puerto publicado para el servicio web.
- Los contenedores reciben límites de 256 MB de memoria, 0,5 CPU y 128 procesos.
- Los contenedores se ejecutan sin capacidades Linux por defecto, salvo las mínimas necesarias para el runtime (`CHOWN`, `SETUID`, `SETGID` y `NET_BIND_SERVICE`), y con `no-new-privileges`.
- Las sesiones duran mientras tengan actividad; el tiempo de inactividad predeterminado es de dos minutos.
- Las variables de entorno ingresadas desde la interfaz no se guardan de forma persistente.

## Limitaciones conocidas

El runner no es un reemplazo completo de `docker compose`. Está pensado para previews aisladas, no para administrar el Docker del host ni para ejecutar stacks de producción.

Algunas imágenes pueden no funcionar aunque su YAML sea válido. En particular, aplicaciones que necesitan escribir archivos de configuración durante el arranque, cambiar permisos del volumen, usar el socket Docker, ejecutar como `privileged` o acceder a rutas del host pueden terminar con errores de permisos o no iniciar. Homepage, por ejemplo, puede requerir ajustes adicionales para inicializar `/app/config` dentro de las restricciones actuales.

El preview depende de que el servicio escuche en todas las interfaces (`0.0.0.0`) y de que el proceso permanezca activo después de iniciar. Si el proceso se cierra, el panel puede mostrar inicialmente “Preview lista” y luego un error como `ECONNRESET`.

## Variables de configuración

El servidor admite estas variables:

- `PORT`: puerto HTTP del launcher; por defecto `3000`.
- `DOCKER_SOCKET`: socket Docker; por defecto `/var/run/docker.sock`.
- `PREVIEW_TARGET_HOST`: host utilizado por el proxy para alcanzar los puertos publicados; por defecto `127.0.0.1`.
- `SESSION_IDLE_SECONDS`: tiempo de inactividad antes de limpiar una sesión; por defecto `120`.
- `STARTUP_TIMEOUT_SECONDS`: tiempo máximo de espera para que el servicio web acepte conexiones; por defecto `90`.

## Seguridad

El acceso al socket Docker del host es una capacidad sensible y debe protegerse. La aplicación aplica una lista de opciones Compose bloqueadas, límites de recursos, redes aisladas, nombres de contenedor propios y limpieza automática. Aun así, debe ejecutarse únicamente con imágenes de confianza y en un entorno destinado a pruebas.
