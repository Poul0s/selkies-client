CERT_DIR  := certs
CERT_PFX  := $(CERT_DIR)/selkies-client.pfx
CERT_PASS ?= selkies
OSSL_DIR  := tools
OSSL_BIN  := $(OSSL_DIR)/pkg/usr/bin/osslsigncode

.PHONY: help install start build build-linux build-win cert clean distclean

help:
	@echo "make install      installe les dépendances npm"
	@echo "make start        lance l'app en mode dev"
	@echo "make build        AppImage Linux + .exe Windows portable (signé)"
	@echo "make build-linux  AppImage seulement"
	@echo "make build-win    .exe portable seulement (signé avec $(CERT_PFX))"
	@echo "make cert         (re)génère le certificat auto-signé"
	@echo "make clean        supprime dist/"
	@echo "make distclean    supprime dist/, node_modules/ et certs/"

install:
	npm install

node_modules: package.json
	npm install
	@touch node_modules

start: node_modules
	npm start

build: build-linux build-win

build-linux: node_modules
	npm run dist:linux

build-win: node_modules $(CERT_PFX) $(OSSL_BIN)
	ELECTRON_BUILDER_OSSL_SIGNCODE_PATH=$(abspath $(OSSL_BIN)) WIN_CSC_LINK=$(abspath $(CERT_PFX)) WIN_CSC_KEY_PASSWORD=$(CERT_PASS) npm run dist:win

OSSL_VER  := 2.14
OSSL_SRC  := $(OSSL_DIR)/src/osslsigncode-$(OSSL_VER)

# osslsigncode: use apt if available (Debian/Ubuntu), else build from source
# (no root needed either way, e.g. Arch where it is only in the AUR)
$(OSSL_BIN):
ifneq ($(shell command -v apt-get),)
	@mkdir -p $(OSSL_DIR)/dl
	cd $(OSSL_DIR)/dl && apt-get download osslsigncode
	dpkg-deb -x $(OSSL_DIR)/dl/osslsigncode_*.deb $(OSSL_DIR)/pkg
else
	@mkdir -p $(OSSL_SRC) $(dir $(OSSL_BIN))
	curl -fsSL https://github.com/mtrojnar/osslsigncode/archive/refs/tags/$(OSSL_VER).tar.gz \
	  | tar -xz -C $(OSSL_SRC) --strip-components=1
	cmake -S $(OSSL_SRC) -B $(OSSL_SRC)/build -DCMAKE_BUILD_TYPE=Release
	cmake --build $(OSSL_SRC)/build -j
	install -Dm755 $(OSSL_SRC)/build/osslsigncode $(OSSL_BIN)
endif

$(CERT_PFX):
	@mkdir -p $(CERT_DIR)
	openssl req -x509 -newkey rsa:3072 -sha256 -days 1095 -nodes \
	  -keyout $(CERT_DIR)/key.pem -out $(CERT_DIR)/cert.pem \
	  -subj "/CN=Selkies Client" \
	  -addext "keyUsage=digitalSignature" \
	  -addext "extendedKeyUsage=codeSigning"
	openssl pkcs12 -export -inkey $(CERT_DIR)/key.pem -in $(CERT_DIR)/cert.pem \
	  -out $(CERT_PFX) -passout pass:$(CERT_PASS)

cert:
	rm -rf $(CERT_DIR)
	$(MAKE) $(CERT_PFX)

clean:
	rm -rf dist

distclean: clean
	rm -rf node_modules $(CERT_DIR) $(OSSL_DIR)
