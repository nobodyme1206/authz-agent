package sample.c04;
import java.security.Principal;
import org.springframework.web.bind.annotation.*;
@RestController
@RequestMapping("/c04")
public class Controller {
    private Mapper mapper;
    @PostMapping("/records")
    public void run(@RequestParam String id, @RequestParam String value, Principal principal) {
        mapper.update(id, value);
        if (!principal.getName().equals(mapper.owner(id))) return;
    }
}
