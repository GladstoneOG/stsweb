pluginManagement {
    repositories {
        mavenCentral()
        maven { url = uri("https://teavm.org/maven/repository/") }
        gradlePluginPortal()
    }
}

rootProject.name = "stsweb"
include(":core", ":web")
