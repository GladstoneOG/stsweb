plugins {
    id("java-library")
}

java {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
}

tasks.withType<JavaCompile>().configureEach {
    options.encoding = "UTF-8"
}

dependencies {
    api("com.badlogicgames.gdx:gdx:1.14.2")
    api("com.badlogicgames.gdx:gdx-freetype:1.14.2")
    api("com.badlogicgames.gdx-controllers:gdx-controllers-core:2.2.4")
}
