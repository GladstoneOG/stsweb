import org.teavm.gradle.api.OptimizationLevel

plugins {
    id("java")
    id("com.github.xpenatan.gdx-teavm") version "1.6.2"
}

java {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
}

tasks.withType<JavaCompile>().configureEach {
    options.encoding = "UTF-8"
}

dependencies {
    implementation(project(":core"))
    implementation("com.badlogicgames.gdx:gdx:1.14.2")
    implementation("com.github.xpenatan.gdx-teavm:gdx-freetype-web:1.6.2")
    implementation("com.github.xpenatan.gdx-teavm:gdx-controllers-web:1.6.2")
}

gdxTeaVM {
    webDefaults {
        mainClass.set("com.megacrit.cardcrawl.web.StsWebLauncher")
        generateIndexHtml.set(false)
        copyAssets.set(true)
        copyLoadingAsset.set(false)
        htmlTitle.set("Slay the Spire Web")
        htmlWidth.set(1280)
        htmlHeight.set(720)
        optimization.set(OptimizationLevel.BALANCED)
        obfuscated.set(false)
        outOfProcess.set(true)
        processMemory.set(2048)
    }

    js {
        targetFileName.set("app.js")
        sourceMap.set(false)
    }
}

tasks.register<Copy>("syncWebDist") {
    dependsOn("gdx_teavm_web_js_build")
    val distDir = layout.buildDirectory.dir("dist/js/webapp")
    val publicDir = rootProject.layout.projectDirectory.dir("../public")

    from(distDir) {
        include("app.js")
        include("app.js.*")
        include("scripts/**")
        include("assets/com/**")
    }
    into(publicDir)
}
