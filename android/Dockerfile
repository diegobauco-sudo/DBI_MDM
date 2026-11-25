# Compila el APK en cualquier sistema con Docker, con las mismas herramientas de build-apk.sh:
#   docker build -t wifly-apk . && docker run --rm -v "$PWD:/src" wifly-apk
FROM ubuntu:24.04
RUN apt-get update -qq && apt-get install -y -qq openjdk-21-jdk-headless aapt apksigner dalvik-exchange zipalign android-sdk-platform-23
WORKDIR /src
CMD ["bash", "tools/build-apk.sh"]
